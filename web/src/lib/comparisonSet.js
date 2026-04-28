// Сборка набора кандидатов и финального селекшна для радара.
// Используется в Comparison.jsx — здесь чистая логика, без UI.

import { getAllIssuers } from '../data/issuersMock.js';
import { positions as portfolioPositions } from '../data/mockPortfolio.js';
import { metricSpec, RADAR_AXES } from '../data/comparisonMetrics.js';
import { resolveNorm, classifyValue } from './norms.js';
import { percentileRanks } from './percentile.js';

// Источники → набор пар { id, kind } доступных кандидатов.
// kind определяется тем, в каком источнике эмитент засвечен. Один
// эмитент может фигурировать сразу в нескольких kind'ах (если у него,
// например, и облигации в портфеле, и акция в просмотренных).
export function buildPool({ sources, industryFilter, recentItems, favItems }){
  const issuers = getAllIssuers();
  const byId = new Map(issuers.map(i => [i.id, i]));
  const pool = new Map();   // ключ `${id}/${kind}` → { id, kind, iss }

  const add = (id, kind) => {
    const iss = byId.get(id);
    if(!iss) return;
    const key = `${id}/${kind}`;
    if(pool.has(key)) return;
    pool.set(key, { id, kind, iss });
  };

  if(sources.recent && Array.isArray(recentItems)){
    for(const r of recentItems){
      if(r.kind !== 'issuer') continue;
      const iss = byId.get(r.refId);
      if(!iss) continue;
      // Добавляем во все имеющиеся kind'ы у этого эмитента.
      for(const k of iss.kinds) add(iss.id, k);
    }
  }
  if(sources.portfolio){
    for(const p of portfolioPositions){
      // Mock-портфель — только облигации; будущие акции/фьючерсы
      // подхватятся теми же kind'ами, когда появятся в данных.
      add(p.issuer, 'bond');
    }
  }
  if(sources.favorites && Array.isArray(favItems)){
    for(const f of favItems){
      if(!f) continue;
      const iss = byId.get(f.refId);
      if(!iss) continue;
      for(const k of iss.kinds) add(iss.id, k);
    }
  }
  if(sources.industry && industryFilter){
    for(const iss of issuers){
      if(iss.industry !== industryFilter) continue;
      for(const k of iss.kinds) add(iss.id, k);
    }
  }
  if(sources.all){
    for(const iss of issuers){
      for(const k of iss.kinds) add(iss.id, k);
    }
  }
  return [...pool.values()];
}

// Применить multipliers-фильтр (min/max) к пулу.
export function applyMultFilters(pool, filters){
  return pool.filter(({ iss }) => {
    for(const [mid, f] of Object.entries(filters)){
      const min = f.min === '' ? null : parseFloat(f.min);
      const max = f.max === '' ? null : parseFloat(f.max);
      const v = iss.mults?.[mid];
      if(min != null && (v == null || v < min)) return false;
      if(max != null && (v == null || v > max)) return false;
    }
    return true;
  });
}

// Top-N: сумма перцентилей (по выбранным метрикам).
export function applyTopNSum(pool, metrics, n){
  if(!metrics.length || !pool.length) return pool;
  const ranks = metrics.map(mid => {
    const spec = metricSpec(mid);
    const vals = pool.map(({ iss }) => iss.mults?.[mid] ?? null);
    return percentileRanks(vals, spec?.higher !== false);
  });
  const scored = pool.map((p, i) => {
    let sum = 0, k = 0;
    for(const r of ranks){
      if(r[i] != null){ sum += r[i]; k++; }
    }
    return { p, score: k ? sum / k : -Infinity };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, n)).map(x => x.p);
}

// Top-N: последовательная воронка по нормам отрасли (без N — сколько
// прошло, столько прошло). Метрики применяются строго по очереди:
// после первой остаётся только зелёная зона, потом из них фильтр
// второй и т.д. Если у метрики нет нормы для отрасли, метрика
// пропускается без фильтрации.
export function applyTopNSequential(pool, metrics, normsCtx){
  let cur = pool;
  for(const mid of metrics){
    const spec = metricSpec(mid);
    if(!spec || spec.percentileBased) continue;
    cur = cur.filter(({ iss }) => {
      const v = iss.mults?.[mid];
      const norm = resolveNorm(iss.industry, mid, normsCtx);
      if(!norm) return true;  // нет нормы — не отрезаем
      return classifyValue(v, norm, spec.higher) === 'green';
    });
  }
  return cur;
}

// Финальный набор для радара. selected — массив { id, kind, visible }
// из стора. visibleOnly=true даёт только видимых.
export function buildSelectedView(selected, visibleOnly){
  const issuers = getAllIssuers();
  const byId = new Map(issuers.map(i => [i.id, i]));
  return selected
    .filter(x => !visibleOnly || x.visible)
    .map(x => ({ ...x, iss: byId.get(x.id) }))
    .filter(x => x.iss);
}

// Сборка данных для recharts RadarChart. Возвращает массив точек,
// одна точка на ось.
//   [
//     { axis: 'ND/EBITDA', SBER: 12, LKOH: 90, ... },
//     ...
//   ]
// Значения нормированы в 0..100 через percentile-rank внутри текущего
// набора видимых эмитентов (как в old _crossRanks).
export function buildRadarData(selectedView){
  const visible = selectedView.filter(x => x.visible);
  if(!visible.length) return [];
  const data = RADAR_AXES.map(axisId => {
    const spec = metricSpec(axisId);
    const vals = visible.map(x => x.iss.mults?.[axisId] ?? null);
    const ranks = percentileRanks(vals, spec.higher !== false);
    const point = { axis: spec.short, axisId };
    visible.forEach((x, i) => {
      point[x.id + '|' + x.kind] = ranks[i] ?? 0;
    });
    return point;
  });
  return data;
}
