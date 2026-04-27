import { MULTIPLIERS, safetyScore, bqiScore } from '../../data/bondsCatalog.js';

// Дефолтные значения всех фильтров. Используется и как initial state,
// и как «эталон» для сброса (onPatch(null) применяет это).
export const DEFAULT_FILTERS = {
  type: 'any', listing: [], currency: ['RUB'], trend: 'any',
  priceMin: '', priceMax: '',
  couponMin: '', couponMax: '',
  ytmMin: '', ytmMax: '',
  yieldMin: '', yieldMax: '',
  durMin: '', durMax: '',
  couponMode: 'any', spreadQuery: '',
  freq: [], amort: 'any', offer: 'any',
  volMin: '', volMax: '',
  ratings: [], ratingTrend: 'any', outsiders: 'off',
  mults: {},
};

const num = v => (v === '' || v == null ? null : Number(v));

// Достать значение метрики у бумаги: либо через spec.resolver
// (composite — safety/bqi), либо напрямую из b.mults.
function metricValue(spec, b){
  if(typeof spec.resolver === 'function') return spec.resolver(b);
  return b.mults?.[spec.id];
}

// Применить фильтры + multi-key sort. Сортировка идёт в порядке, в
// котором мультипликаторы перечислены в MULTIPLIERS — первый с
// активным dir даёт основной ключ, остальные — tie-breakers.
export function applyFilters(items, f){
  if(!f) return items;
  let rows = items.filter(b => paperOk(b, f) && issuerOk(b, f));

  if(f.outsiders && f.outsiders !== 'off'){
    rows = applyOutsiders(rows, f.outsiders);
  }

  // Собираем все активные сортировки в порядке приоритета (по списку MULTIPLIERS).
  const sortKeys = MULTIPLIERS
    .map(spec => ({ spec, st: f.mults?.[spec.id] }))
    .filter(x => x.st && x.st.dir && x.st.dir !== 'both');
  if(sortKeys.length){
    rows = [...rows].sort((a, b) => {
      for(const { spec, st } of sortKeys){
        const av = metricValue(spec, a), bv = metricValue(spec, b);
        if(av == null && bv == null) continue;
        if(av == null) return 1;
        if(bv == null) return -1;
        // best = от лучших к худшим: для higher=true — по убыванию
        const ascend = (st.dir === 'best' && !spec.higher) || (st.dir === 'worst' && spec.higher);
        const cmp = ascend ? av - bv : bv - av;
        if(cmp !== 0) return cmp;
      }
      return 0;
    });
  }
  return rows;
}

function paperOk(b, f){
  if(f.type !== 'any' && b.type !== f.type) return false;
  if(f.listing.length && !f.listing.includes(b.listing)) return false;
  if(f.currency.length && !f.currency.includes(b.currency)) return false;
  if(f.trend !== 'any' && b.trend !== f.trend) return false;

  const pMin = num(f.priceMin), pMax = num(f.priceMax);
  if(pMin != null && b.price < pMin) return false;
  if(pMax != null && b.price > pMax) return false;

  const yMin = num(f.ytmMin), yMax = num(f.ytmMax);
  if(yMin != null && b.ytm < yMin) return false;
  if(yMax != null && b.ytm > yMax) return false;

  const ymMin = num(f.yieldMin), ymMax = num(f.yieldMax);
  if(ymMin != null && b.yield_to_mat < ymMin) return false;
  if(ymMax != null && b.yield_to_mat > ymMax) return false;

  const dMin = num(f.durMin), dMax = num(f.durMax);
  if(dMin != null && b.duration_years < dMin) return false;
  if(dMax != null && b.duration_years > dMax) return false;

  if(f.couponMode && f.couponMode !== 'any' && b.coupon_mode !== f.couponMode) return false;
  if(f.spreadQuery && b.coupon_mode === 'float'){
    if(!(b.coupon_spread || '').toLowerCase().includes(f.spreadQuery.toLowerCase())) return false;
  }

  if(f.freq.length){
    const ok = f.freq.includes('any') || f.freq.includes(b.coupon_freq);
    if(!ok) return false;
  }
  if(f.amort && f.amort !== 'any' && b.amort !== f.amort) return false;
  if(f.offer && f.offer !== 'any' && b.offer !== f.offer) return false;

  const vMin = num(f.volMin), vMax = num(f.volMax);
  if(vMin != null && b.volume_bn < vMin) return false;
  if(vMax != null && b.volume_bn > vMax) return false;

  return true;
}

function issuerOk(b, f){
  if(f.ratings.length){
    const tag = b.rating || 'none';
    if(!f.ratings.includes(tag)) return false;
  }
  if(f.ratingTrend && f.ratingTrend !== 'any' && b.ratingTrend !== f.ratingTrend) return false;

  // Мультипликаторы и composite-индексы (safety/bqi) — единый цикл.
  for(const spec of MULTIPLIERS){
    const v = f.mults?.[spec.id];
    if(!v) continue;
    const mn = num(v.min), mx = num(v.max);
    if(mn == null && mx == null) continue;
    const x = metricValue(spec, b);
    if(x == null) return false;
    if(mn != null && x < mn) return false;
    if(mx != null && x > mx) return false;
  }
  return true;
}

function applyOutsiders(rows, mode){
  const byInd = new Map();
  for(const b of rows){
    const k = b.industry || 'other';
    if(!byInd.has(k)) byInd.set(k, []);
    byInd.get(k).push(b);
  }
  const out = new Set();
  for(const [, list] of byInd){
    const scored = list.map(b => ({ b, s: safetyScore(b) })).filter(x => x.s != null);
    if(!scored.length) continue;
    scored.sort((a, b) => a.s - b.s);
    const cutPct = mode === 'p75' ? 0.25 : mode === 'p80' ? 0.20 : mode === 'p90' ? 0.10 : 0.25;
    const cutN = Math.max(1, Math.round(scored.length * cutPct));
    const losers = scored.slice(0, cutN).map(x => x.b);
    if(mode === 'only'){
      losers.forEach(b => out.add(b));
    } else {
      list.filter(b => !losers.includes(b)).forEach(b => out.add(b));
    }
  }
  if(mode === 'only') return [...out];
  return rows.filter(b => out.has(b));
}

// re-export для использования в других местах (Bonds.jsx таблица)
export { safetyScore, bqiScore };
