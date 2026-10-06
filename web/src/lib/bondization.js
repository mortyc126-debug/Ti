// Расписание выплат по облигации из MOEX ISS (bondization): купоны и
// амортизации по каждому выпуску. Открытый источник, CORS ок. Кэш в
// localStorage (расписание меняется редко). На вход — SECID биржи
// (для ОФЗ он не равен ISIN; у корпоратов обычно совпадает).

const CACHE_KEY = 'ba_bondization_v1';
const TTL = 7 * 864e5;   // неделя

function _cacheGet(){ try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch(_){ return {}; } }
function _cacheSet(m){ try { localStorage.setItem(CACHE_KEY, JSON.stringify(m)); } catch(_){} }

function _block(b){
  const ci = {}; (b && b.columns || []).forEach((c, i) => { ci[c] = i; });
  return { ci, rows: (b && b.data) || [] };
}

// → { events:[{date,type:'coupon'|'amort',perBond,rate?}], face, mat }
function _parse(d){
  const events = [];
  let face = null, mat = null;
  if(d && d.coupons){
    const { ci, rows } = _block(d.coupons);
    for(const r of rows){
      const date = r[ci.coupondate];
      const val = (ci.value_rub != null && r[ci.value_rub] != null) ? r[ci.value_rub] : r[ci.value];
      const rate = ci.valueprc != null ? r[ci.valueprc] : null;
      if(date && val != null && isFinite(+val)) events.push({ date, type: 'coupon', perBond: +val, rate: (rate != null && isFinite(+rate)) ? +rate : null });
      if(ci.facevalue != null && r[ci.facevalue] != null) face = +r[ci.facevalue];
    }
  }
  if(d && d.amortizations){
    const { ci, rows } = _block(d.amortizations);
    for(const r of rows){
      const date = r[ci.amortdate];
      const val = (ci.value_rub != null && r[ci.value_rub] != null) ? r[ci.value_rub] : r[ci.value];
      if(date && val != null && isFinite(+val) && +val > 0) events.push({ date, type: 'amort', perBond: +val });
      if(date && (!mat || date > mat)) mat = date;
    }
  }
  events.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return { events, face, mat };
}

export async function loadBondization(secid){
  const key = String(secid || '').toUpperCase();
  if(!key) return null;
  const cache = _cacheGet();
  const hit = cache[key];
  if(hit && Date.now() - hit.ts < TTL) return hit.data;
  try {
    const r = await fetch('https://iss.moex.com/iss/securities/' + encodeURIComponent(key) + '/bondization.json?iss.meta=off&limit=1000');
    if(!r.ok) return hit ? hit.data : null;
    const d = await r.json();
    const data = _parse(d);
    cache[key] = { ts: Date.now(), data };
    _cacheSet(cache);
    return data;
  } catch(_){ return hit ? hit.data : null; }
}

// Будущие события портфеля: события выпуска × количество бумаг.
// positions: [{secid|isin, qty, bond:{events}}]
// Возвращает плоский список {date, type, amount} (amount — рубли на весь пакет).
export function futureEvents(bondByKey, positions, fromDate){
  const now = fromDate ? new Date(fromDate) : new Date();
  const out = [];
  for(const p of positions){
    const b = bondByKey[(p.secid || p.isin || '').toUpperCase()];
    if(!b || !b.events) continue;
    for(const e of b.events){
      const dt = new Date(e.date);
      if(!(dt > now)) continue;
      out.push({ date: e.date, type: e.type, amount: e.perBond * (p.qty || 0), name: p.name, issuer: p.issuer });
    }
  }
  out.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return out;
}

// Агрегация будущих событий по месяцам (YYYY-MM) на horizon месяцев вперёд.
// → [{month:'2026-01', label:'янв 26', coupon, amort, total}]
const _MON = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export function scheduleByMonth(events, horizon){
  const now = new Date();
  const buckets = new Map();
  for(let i = 0; i < (horizon || 12); i++){
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    buckets.set(k, { month: k, label: _MON[d.getMonth()] + ' ' + String(d.getFullYear()).slice(2), coupon: 0, amort: 0, total: 0 });
  }
  for(const e of events){
    const k = e.date.slice(0, 7);
    const b = buckets.get(k);
    if(!b) continue;
    if(e.type === 'coupon') b.coupon += e.amount; else b.amort += e.amount;
    b.total += e.amount;
  }
  return [...buckets.values()];
}

// YTM (эффективная доходность к погашению) методом биссекции по IRR.
// events — события ОДНОГО выпуска (perBond), dirtyPerBond — грязная цена
// за 1 бумагу (цена + НКД), ₽. Возвращает % годовых или null.
export function computeYtm(bond, dirtyPerBond, fromDate){
  if(!bond || !bond.events || !(dirtyPerBond > 0)) return null;
  const now = fromDate ? new Date(fromDate) : new Date();
  const cfs = [];
  for(const e of bond.events){
    const t = (new Date(e.date) - now) / (365 * 864e5);
    if(t > 0) cfs.push({ t, cf: e.perBond });
  }
  if(!cfs.length) return null;
  const npv = y => cfs.reduce((s, c) => s + c.cf / Math.pow(1 + y, c.t), 0) - dirtyPerBond;
  let lo = -0.9, hi = 3;
  let flo = npv(lo), fhi = npv(hi);
  if(flo * fhi > 0) return null;           // корень не в диапазоне
  for(let i = 0; i < 200; i++){
    const mid = (lo + hi) / 2, fm = npv(mid);
    if(Math.abs(fm) < 1e-7){ return mid * 100; }
    if(flo * fm < 0){ hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2 * 100;
}

// Дюрация Маколея (годы) при известной доходности y (доля).
export function duration(bond, y, fromDate){
  if(!bond || !bond.events || y == null) return null;
  const now = fromDate ? new Date(fromDate) : new Date();
  let pvSum = 0, tw = 0;
  for(const e of bond.events){
    const t = (new Date(e.date) - now) / (365 * 864e5);
    if(t <= 0) continue;
    const pv = e.perBond / Math.pow(1 + y, t);
    pvSum += pv; tw += t * pv;
  }
  return pvSum > 0 ? tw / pvSum : null;
}
