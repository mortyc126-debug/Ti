import { MULTIPLIERS, safetyScore } from '../../data/bondsCatalog.js';

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
  safetyMin: '',
  mults: {},
};

// Маленький хелпер: число или null если поле пустое.
const num = v => (v === '' || v == null ? null : Number(v));

// Применить фильтры + сортировку. Возвращает массив отсортированных
// записей. Все условия — AND. Пустые поля пропускаются.
export function applyFilters(items, f){
  if(!f) return items;
  let rows = items.filter(b => paperOk(b, f) && issuerOk(b, f));

  // Аутсайдеры — отдельная пост-обработка по перцентилю safetyScore
  // внутри отрасли. Считаем только когда нужно (off — пропускаем).
  if(f.outsiders && f.outsiders !== 'off'){
    rows = applyOutsiders(rows, f.outsiders);
  }

  // Сортировка: ищем первый мультипликатор с непустым dir.
  const sortKey = Object.entries(f.mults || {}).find(([, v]) => v && v.dir && v.dir !== 'both');
  if(sortKey){
    const [id, { dir }] = sortKey;
    const spec = MULTIPLIERS.find(m => m.id === id);
    if(spec){
      // best = от лучших к худшим; направление лучших задано spec.higher
      const ascend = (dir === 'best' && !spec.higher) || (dir === 'worst' && spec.higher);
      rows = [...rows].sort((a, b) => {
        const av = a.mults?.[id], bv = b.mults?.[id];
        if(av == null && bv == null) return 0;
        if(av == null) return 1;
        if(bv == null) return -1;
        return ascend ? av - bv : bv - av;
      });
    }
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
    // 'none' матчится явно
    const tag = b.rating || 'none';
    if(!f.ratings.includes(tag)) return false;
  }
  if(f.ratingTrend && f.ratingTrend !== 'any' && b.ratingTrend !== f.ratingTrend) return false;

  const sMin = num(f.safetyMin);
  if(sMin != null){
    const s = safetyScore(b);
    if(s == null || s < sMin) return false;
  }

  // Мультипликатор-фильтры — только по min/max, dir влияет на сортировку.
  for(const m of MULTIPLIERS){
    const v = f.mults?.[m.id];
    if(!v) continue;
    const mn = num(v.min), mx = num(v.max);
    if(mn == null && mx == null) continue;
    const x = b.mults?.[m.id];
    if(x == null) return false;          // пользователь явно фильтрует — нет данных = выкидываем
    if(mn != null && x < mn) return false;
    if(mx != null && x > mx) return false;
  }
  return true;
}

function applyOutsiders(rows, mode){
  // Группируем по отрасли, считаем safetyScore для каждого и оставляем
  // тех, кто ниже соответствующего перцентиля.
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
    scored.sort((a, b) => a.s - b.s);   // снизу вверх (худшие → лучшие)
    const cutPct = mode === 'p75' ? 0.25 : mode === 'p80' ? 0.20 : mode === 'p90' ? 0.10 : 0.25;
    const cutN = Math.max(1, Math.round(scored.length * cutPct));
    const losers = scored.slice(0, cutN).map(x => x.b);
    if(mode === 'only'){
      losers.forEach(b => out.add(b));
    } else {
      // Отсекаем losers — оставляем остальных
      list.filter(b => !losers.includes(b)).forEach(b => out.add(b));
    }
  }
  // если 'only' — возвращаем только то что в out; иначе — пересечение
  if(mode === 'only') return [...out];
  return rows.filter(b => out.has(b));
}
