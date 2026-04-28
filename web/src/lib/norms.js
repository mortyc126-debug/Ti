// Резолвинг эффективных норм для пары (industry, metric).
// Приоритет источников:
//   1) Manual override (пользовательская правка)
//   2) Автокалибровка по reportsDB (если включена и сэмпл ≥ 5)
//   3) Хардкод-дефолт (Тир 1 / Тир 2)
//
// Кэш считается лениво и сбрасывается при изменении состава
// эмитентов (по hash-сигнатуре сэмпла).

import { defaultNormFor } from '../data/industryNorms.js';
import { metricSpec } from '../data/comparisonMetrics.js';
import { INDUSTRIES } from '../data/industries.js';
import { weightedQuantile, freshnessWeight, winsorBounds } from './percentile.js';
import { reportAgeYears } from '../data/issuersMock.js';

const MIN_SAMPLE = 5;
const HALF_LIFE_YEARS = 2;

// Простой кэш по подписи (industry, metric, hashRows).
const cache = new Map();

function rowsSignature(rows){
  // Мини-хеш: длина + сумма свежестей + сумма значений (приближённо).
  let s = rows.length * 31;
  for(const r of rows) s = (s * 17 + ((r.weight || 0) * 1e6 | 0)) | 0;
  return s;
}

// Собрать сэмпл (value, weight) для отрасли и метрики.
function buildSample(issuers, industryId, metricId){
  const out = [];
  for(const iss of issuers){
    if(iss.industry !== industryId) continue;
    const v = iss.mults?.[metricId];
    if(v == null || !isFinite(v)) continue;
    const w = freshnessWeight(reportAgeYears(iss), HALF_LIFE_YEARS) ?? 1;
    out.push({ value: v, weight: w });
  }
  return out;
}

// Сэмпл по группе (если в самой отрасли мало эмитентов).
function buildGroupSample(issuers, industryId, metricId){
  const groupId = INDUSTRIES[industryId]?.groupId;
  if(!groupId) return [];
  const out = [];
  for(const iss of issuers){
    const g = INDUSTRIES[iss.industry]?.groupId;
    if(g !== groupId) continue;
    const v = iss.mults?.[metricId];
    if(v == null || !isFinite(v)) continue;
    const w = freshnessWeight(reportAgeYears(iss), HALF_LIFE_YEARS) ?? 1;
    out.push({ value: v, weight: w });
  }
  return out;
}

// Калиброванная норма из сэмпла. green/red — квартили (для higher=true)
// или нижние квартили (для higher=false).
function calibrateFromSample(sample, higher){
  if(sample.length < MIN_SAMPLE) return null;
  const values = sample.map(x => x.value);
  const weights = sample.map(x => x.weight);
  // Винзоризация — отсечь хвосты, чтобы один банкрот не сдвигал.
  const { lo, hi } = winsorBounds(values, weights, 0.02, 0.98);
  const clipped = values.map(v => Math.max(lo ?? -Infinity, Math.min(hi ?? Infinity, v)));
  const q25 = weightedQuantile(clipped, weights, 0.25);
  const q75 = weightedQuantile(clipped, weights, 0.75);
  if(q25 == null || q75 == null) return null;
  // higher=true: green = q75 (выше — отличный), red = q25 (ниже — плохо).
  // higher=false: green = q25 (ниже — лучше), red = q75 (выше — плохо).
  return higher
    ? { green: q75, red: q25, source: 'auto', n: sample.length }
    : { green: q25, red: q75, source: 'auto', n: sample.length };
}

// Главный резолвер. opts:
//   - issuers: массив карточек (для автокалибровки),
//   - autocalibrate: bool,
//   - overrides: { [`${industry}/${metric}`]: { green, red } }.
export function resolveNorm(industryId, metricId, opts){
  const { issuers = [], autocalibrate = true, overrides = {} } = opts || {};
  // Сначала точечный override по конкретной отрасли (если когда-нибудь
  // добавим UI правки на уровне узкой отрасли).
  const ov = overrides[`${industryId}/${metricId}`];
  if(ov){
    return { ...ov, source: 'manual' };
  }
  // Override по группе — текущий формат UI «Нормы».
  const groupId = INDUSTRIES[industryId]?.groupId;
  if(groupId){
    const ovG = overrides[`__group:${groupId}/${metricId}`];
    if(ovG) return { ...ovG, source: 'manual' };
  }
  const spec = metricSpec(metricId);
  if(!spec) return null;
  if(autocalibrate){
    const sig = rowsSignature(issuers.map(i => ({ weight: i.reportDaysAgo || 0 })));
    const cacheKey = `${industryId}/${metricId}/${sig}`;
    if(cache.has(cacheKey)) return cache.get(cacheKey);
    const own = buildSample(issuers, industryId, metricId);
    let calibrated = calibrateFromSample(own, spec.higher);
    let scope = 'industry';
    if(!calibrated){
      const grp = buildGroupSample(issuers, industryId, metricId);
      calibrated = calibrateFromSample(grp, spec.higher);
      scope = 'group';
    }
    if(calibrated){
      const result = { ...calibrated, scope };
      cache.set(cacheKey, result);
      return result;
    }
  }
  // Фолбэк на хардкод.
  return defaultNormFor(industryId, metricId);
}

// Очистить кэш (вызывать при добавлении/удалении эмитентов).
export function clearNormCache(){
  cache.clear();
}

// Какая зона у значения относительно нормы. green/yellow/red/null.
export function classifyValue(value, norm, higher){
  if(value == null || !isFinite(value) || !norm) return null;
  if(higher){
    if(value >= norm.green) return 'green';
    if(value >= norm.red)   return 'yellow';
    return 'red';
  } else {
    if(value <= norm.green) return 'green';
    if(value <= norm.red)   return 'yellow';
    return 'red';
  }
}

// Для UI «origin» бейджа. Кратко.
export function normSourceLabel(source){
  switch(source){
    case 'manual':            return 'вручную';
    case 'auto':              return 'авто';
    case 'group':             return 'дефолт (группа)';
    case 'universal':         return 'дефолт';
    case 'universal-finance': return 'дефолт (финансы)';
    default: return '';
  }
}
