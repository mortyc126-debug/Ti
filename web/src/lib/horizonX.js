// Вычисление X-координаты для каждой точки в режиме «Горизонт».
// Источник X задаётся spec'ом: maturity / rating / multiplier / composite.
// Для composite используется sum-перцентиль или последовательная
// воронка по нормам отрасли.

import { ratingOrd } from './qualityComposite.js';
import { metricSpec, COMP_METRICS } from '../data/comparisonMetrics.js';
import { percentileRanks } from './percentile.js';
import { resolveNorm, classifyValue } from './norms.js';
import { getAllIssuers } from '../data/issuersMock.js';

// Подпись X-оси: основная подпись + краткое уточнение направления
// (что значит «правее» / «лучше»). Возвращает { main, hint }.
export function horizonXLabel(spec){
  if(spec.source === 'maturity'){
    return { main: 'срок до погашения, лет', hint: '← короткие · длинные →' };
  }
  if(spec.source === 'marketCap'){
    return { main: 'капитализация, млрд ₽ (лог)', hint: '← мелкие · крупные →' };
  }
  if(spec.source === 'rating'){
    return { main: 'кредитный рейтинг', hint: '← D · AAA → (надёжнее справа)' };
  }
  if(spec.source === 'multiplier'){
    const m = COMP_METRICS[spec.multiplier];
    if(!m) return { main: 'мультипликатор', hint: '' };
    const dir = m.higher
      ? '← хуже · лучше →'
      : '← лучше · хуже →';
    return { main: m.label, hint: dir };
  }
  if(spec.source === 'composite'){
    if(!spec.metrics?.length){
      return { main: 'композит — выбери метрики', hint: '' };
    }
    const names = spec.metrics.map(id => COMP_METRICS[id]?.short || id).join(' + ');
    const mode = spec.mode === 'sequential' ? 'воронка по нормам' : 'сумма перцентилей';
    return {
      main: `композит: ${names}`,
      hint: `${mode} · ← хуже · лучше → (0..100)`,
    };
  }
  return { main: '', hint: '' };
}

// Главная функция: вернёт points с дополненным `xH` (значение для X
// горизонта) + опциональный фильтр (sequential).
//
// points: массив { secid, x, y, mults, rating, industry, ... }
// spec: { source, multiplier, metrics, mode }
//
// returns: { points: filteredPoints[], xMin, xMax, ticks: [{v, label}] }
export function buildHorizonX(points, spec){
  if(!points.length){
    return { points: [], xMin: 0, xMax: 1, ticks: [] };
  }

  if(spec.source === 'maturity'){
    return makeFromValues(points, p => p.x, { numericTicks: true });
  }
  if(spec.source === 'marketCap'){
    // Лог-шкала: крупные эмитенты не должны прижимать карликов.
    return makeFromValues(
      points,
      p => p.volumeBn != null && p.volumeBn > 0 ? Math.log10(p.volumeBn) : null,
      { logTicks: true },
    );
  }
  if(spec.source === 'rating'){
    return makeFromValues(points, p => ratingOrd(p.rating), { ratingTicks: true });
  }
  if(spec.source === 'multiplier'){
    const mid = spec.multiplier;
    const m = COMP_METRICS[mid];
    return makeFromValues(points, p => p.mults?.[mid], { numericTicks: true, fmt: m?.fmt || '' });
  }
  if(spec.source === 'composite'){
    if(!spec.metrics?.length){
      return { points: [], xMin: 0, xMax: 1, ticks: [] };
    }
    return buildCompositeX(points, spec);
  }
  return { points: [], xMin: 0, xMax: 1, ticks: [] };
}

// Простой случай: каждая точка → число от accessor'а.
function makeFromValues(points, accessor, opts){
  const enriched = points
    .map(p => ({ ...p, xH: accessor(p) }))
    .filter(p => p.xH != null && isFinite(p.xH));
  if(!enriched.length) return { points: [], xMin: 0, xMax: 1, ticks: [] };
  const xs = enriched.map(p => p.xH);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const padX = (xMax - xMin) * 0.06 + 0.2;
  return {
    points: enriched,
    xMin: xMin - padX,
    xMax: xMax + padX,
    ticks: makeTicks(xMin - padX, xMax + padX, opts),
  };
}

// Композит. Для каждой выбранной метрики считаем percentile-rank
// (направление-зависимо: для higher=true больше=лучше). Среднее по
// доступным метрикам = X (0..100).
//
// В sequential режиме фильтруем точки: оставляем только тех, кто в
// зелёной зоне нормы своей отрасли по КАЖДОЙ выбранной метрике
// (метрики с percentileBased=true пропускаем без фильтра).
function buildCompositeX(points, spec){
  const issuers = getAllIssuers();
  const normsCtx = { issuers, autocalibrate: true, overrides: {} };

  // 1) Считаем перцентили для каждой метрики на текущем сэмпле.
  const ranksByMetric = {};
  for(const mid of spec.metrics){
    const m = metricSpec(mid);
    if(!m) continue;
    const vals = points.map(p => p.mults?.[mid] ?? null);
    ranksByMetric[mid] = percentileRanks(vals, m.higher !== false);
  }

  // 2) Сводим в композит на каждой точке + (опц.) фильтрация
  //    по последовательной воронке.
  const enriched = [];
  for(let i = 0; i < points.length; i++){
    const p = points[i];

    if(spec.mode === 'sequential'){
      let pass = true;
      for(const mid of spec.metrics){
        const m = metricSpec(mid);
        if(!m || m.percentileBased) continue;     // пропускаем без отсечки
        const v = p.mults?.[mid];
        const norm = resolveNorm(p.industry, mid, normsCtx);
        if(!norm) continue;
        if(classifyValue(v, norm, m.higher) !== 'green'){
          pass = false; break;
        }
      }
      if(!pass) continue;
    }

    const ranks = [];
    for(const mid of spec.metrics){
      const r = ranksByMetric[mid]?.[i];
      if(r != null) ranks.push(r);
    }
    if(!ranks.length) continue;
    const composite = ranks.reduce((s, x) => s + x, 0) / ranks.length;
    enriched.push({ ...p, xH: composite });
  }

  return {
    points: enriched,
    xMin: 0,
    xMax: 100,
    ticks: makeTicks(0, 100, { quartileTicks: true }),
  };
}

function makeTicks(xMin, xMax, opts){
  if(opts?.ratingTicks){
    const RATING_LIST = [
      { ord: 100, label: 'AAA' }, { ord: 92, label: 'AA' }, { ord: 82, label: 'A' },
      { ord: 72, label: 'BBB' }, { ord: 62, label: 'BB' }, { ord: 52, label: 'B' },
      { ord: 35, label: 'CCC' }, { ord: 10, label: 'D' },
    ];
    return RATING_LIST.filter(t => t.ord >= xMin && t.ord <= xMax).map(t => ({ v: t.ord, label: t.label }));
  }
  if(opts?.quartileTicks){
    return [0, 25, 50, 75, 100].map(v => ({ v, label: String(v) }));
  }
  if(opts?.logTicks){
    // Шкала log10: тики на каждом порядке (1, 10, 100, 1000…).
    const ticks = [];
    const start = Math.floor(xMin), end = Math.ceil(xMax);
    for(let v = start; v <= end; v++){
      const real = Math.pow(10, v);
      const lab = real >= 1000 ? (real / 1000).toFixed(real >= 10000 ? 0 : 0) + 'тр.' :
                  real >= 1   ? real.toFixed(0) + ' млрд' :
                                real.toFixed(2);
      ticks.push({ v, label: lab });
    }
    return ticks;
  }
  // Numeric: подбираем шаг.
  const span = xMax - xMin;
  let step;
  if(span > 30) step = 5;
  else if(span > 12) step = 2;
  else if(span > 5) step = 1;
  else if(span > 2) step = 0.5;
  else step = 0.25;
  const ticks = [];
  const start = Math.ceil(xMin / step) * step;
  for(let v = start; v <= xMax; v += step){
    const r = +v.toFixed(2);
    ticks.push({ v: r, label: String(r) + (opts?.fmt || '') });
  }
  return ticks;
}
