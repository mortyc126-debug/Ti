// Реальные карточки эмитентов из backend — замена issuersMock.getAllIssuers().
// Форма карточки сохранена: { id, name, ticker, industry, kinds, mults,
// reportYear, reportDaysAgo, sampleSecid, inn }.
//
// Первый срез: ОДИН дешёвый вызов /reports/latest — последний годовой отчёт
// по каждому эмитенту (issuer_name/ticker/bonds_count через JOIN + метрики).
// Доступные метрики: de (D/EBITDA), ebitdaMarg, roa, ros, equityR. Полные
// (nde, icr, currentR, cashR) требуют per-issuer /reports с сырыми полями
// (cash, ca, cl, int_exp) — подтянем позже лениво. Отрасль (sector) —
// опционально из /catalog; если не отдался, industry='other'.

import { api } from '../api.js';
import { bqiScore, safetyScore } from './bondsCatalog.js';

const _n = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);

// сырая строка отчёта → мультипликаторы (те же ключи, что в COMP_METRICS)
export function reportToMults(r){
  const debt = _n(r.debt), eq = _n(r.eq), assets = _n(r.assets), ebitda = _n(r.ebitda);
  const m = {
    ebitdaMarg: _n(r.ebitda_marg),
    roa: _n(r.roa_pct),
    ros: _n(r.ros_pct),
    de: (ebitda && ebitda > 0 && debt != null) ? debt / ebitda : null,
    nde: _n(r.net_debt_eq),                          // есть в per-issuer, в latest обычно null
    equityR: (eq != null && assets && assets > 0) ? eq / assets * 100 : null,
    icr: null, currentR: null, cashR: null, pe: null, yield: null,
  };
  m.bqi = bqiScore({ mults: m });
  m.safety = safetyScore({ mults: m });
  return m;
}

// маппинг отрасли backend (sector) → industry-ключи UI (data/industries.js)
const _SECTOR_MAP = {
  banks: 'banks', finance: 'finance', 'oil-gas': 'oil-gas', metals: 'metals',
  retail: 'retail', it: 'it', utilities: 'utilities', realestate: 'realestate',
  logistics: 'logistics', agro: 'agro', chemistry: 'chemistry', food: 'food',
  machinery: 'machinery', manufacturing: 'manufacturing', construction: 'construction',
  insurance: 'insurance', services: 'services', state: 'state',
};

export async function loadIssuersReal(){
  const rl = await api.reportsLatest(500);
  const rows = rl?.data || [];
  if(!rows.length) return [];

  // последняя годовая запись на эмитента
  const byInn = new Map();
  for(const r of rows){
    if(!r.inn) continue;
    const cur = byInn.get(r.inn);
    if(!cur || (r.fy_year || 0) > (cur.fy_year || 0)) byInn.set(r.inn, r);
  }

  // отрасли — best-effort из /catalog (может не отдаться на медленной сети)
  const sector = {};
  try {
    const cat = await api.catalog();
    for(const i of (cat?.issuers || [])){
      if(i.inn) sector[i.inn] = i.sector;
    }
  } catch(_){ /* industry='other' */ }

  const out = [];
  for(const [inn, r] of byInn){
    out.push({
      id: inn,
      inn,
      name: r.issuer_name || inn,
      ticker: r.ticker || null,
      industry: _SECTOR_MAP[sector[inn]] || sector[inn] || 'other',
      kinds: ['bond'],
      mults: reportToMults(r),
      reportYear: r.fy_year || null,
      reportDaysAgo: null,
      sampleSecid: null,
    });
  }
  return out;
}
