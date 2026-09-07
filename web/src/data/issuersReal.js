// Реальные карточки эмитентов из backend — замена issuersMock.getAllIssuers().
// Форма карточки: { id, inn, name, ticker, industry, kinds, mults,
// reportYear, reportDaysAgo, sampleSecid }.
//
// Берём ВСЕХ эмитентов с отчётностью (/issuers/report_years, ~324) и тянем
// per-issuer /reports — там сырые поля (cash, ca, cl, int_exp), значит метрики
// ПОЛНЫЕ: nde (ND/EBITDA), icr, currentR, cashR, equityR, de, ebitdaMarg, roa.
// Пул запросов + кэш по эмитенту в localStorage (report'ы меняются раз в
// квартал) + таймауты (тяжёлый /catalog не должен вешать загрузку).

import { api } from '../api.js';
import { bqiScore, safetyScore } from './bondsCatalog.js';

const _n = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
const _ANNUAL = new Set(['FY', 'ГОД', '12М', '12M', 'Y']);

function _timeout(p, ms){
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

// сырая строка отчёта → мультипликаторы (ключи как в COMP_METRICS)
export function reportToMults(r){
  const debt = _n(r.debt), eq = _n(r.eq), assets = _n(r.assets), ebitda = _n(r.ebitda),
        cash = _n(r.cash), ca = _n(r.ca), cl = _n(r.cl), intx = _n(r.int_exp);
  const m = {
    ebitdaMarg: _n(r.ebitda_marg),
    roa: _n(r.roa_pct),
    ros: _n(r.ros_pct),
    de: (ebitda && ebitda > 0 && debt != null) ? debt / ebitda : null,
    nde: (ebitda && ebitda > 0 && debt != null && cash != null) ? (debt - cash) / ebitda : null,
    icr: (intx && intx > 0 && ebitda != null) ? ebitda / intx : null,
    currentR: (cl && cl > 0 && ca != null) ? ca / cl : null,
    cashR: (cl && cl > 0 && cash != null) ? cash / cl : null,
    equityR: (eq != null && assets && assets > 0) ? eq / assets * 100 : null,
    pe: null, yield: null,
  };
  m.bqi = bqiScore({ mults: m });
  m.safety = safetyScore({ mults: m });
  return m;
}

const _SECTOR_MAP = {
  banks: 'banks', finance: 'finance', 'oil-gas': 'oil-gas', metals: 'metals',
  retail: 'retail', it: 'it', utilities: 'utilities', realestate: 'realestate',
  logistics: 'logistics', agro: 'agro', chemistry: 'chemistry', food: 'food',
  machinery: 'machinery', manufacturing: 'manufacturing', construction: 'construction',
  insurance: 'insurance', services: 'services', state: 'state',
};

// тип отчётности: в базе РСБУ приходит в битой кодировке ("Р РЎР‘РЈ") — нормализуем
function _normStd(s){
  if(!s) return 'РСБУ';
  return /МСФО|IFRS/i.test(String(s)) ? 'МСФО' : 'РСБУ';
}

// все годовые отчёты эмитента → [{year, std, mults}] по убыванию года,
// дедуп по (год+тип): при дубле берём первый (буквально любой валидный)
function _annualReports(reports){
  const anns = [];
  for(const r of reports){
    if(!_ANNUAL.has((r.period || '').trim().toUpperCase())) continue;
    if(r.fy_year == null) continue;
    anns.push({ year: Number(r.fy_year), std: _normStd(r.std), mults: reportToMults(r) });
  }
  anns.sort((a, b) => b.year - a.year);
  const seen = new Set();
  const out = [];
  for(const r of anns){
    const k = r.year + '|' + r.std;
    if(seen.has(k)) continue;
    seen.add(k); out.push(r);
  }
  return out;
}

const REP_TTL = 7 * 864e5;   // отчёты меняются редко → кеш на неделю

async function _fetchReports(inn){
  try {
    const raw = localStorage.getItem('ba_rep_' + inn);
    if(raw){ const c = JSON.parse(raw); if(c && Date.now() - c.ts < REP_TTL) return c.data || []; }
  } catch(_){}
  try {
    const d = await _timeout(api.issuerReports(inn), 12000);
    const rows = d?.data || [];
    try { localStorage.setItem('ba_rep_' + inn, JSON.stringify({ ts: Date.now(), data: rows })); } catch(_){}
    return rows;
  } catch(_){ return []; }
}

export async function loadIssuersReal(){
  const ry = await api.issuerReportYears();
  const inns = Object.keys(ry?.map || {});
  if(!inns.length) return [];

  // имена/сектора — best-effort (тяжёлый /catalog, с таймаутом)
  const meta = {};
  try {
    const cat = await _timeout(api.catalog(), 15000);
    for(const i of (cat?.issuers || [])){
      if(i.inn) meta[i.inn] = { name: i.name, ticker: i.ticker, sector: i.sector };
    }
  } catch(_){ /* без секторов → industry='other' */ }

  // per-issuer отчёты пулом
  const out = [];
  let idx = 0;
  const CONC = 6;
  async function worker(){
    while(idx < inns.length){
      const inn = inns[idx++];
      const rows = await _fetchReports(inn);
      const reps = _annualReports(rows);
      if(!reps.length) continue;
      const mm = meta[inn] || {};
      out.push({
        id: inn, inn,
        name: mm.name || inn,
        ticker: mm.ticker || null,
        industry: _SECTOR_MAP[mm.sector] || mm.sector || 'other',
        kinds: ['bond'],
        reports: reps,            // [{year, std, mults}] по убыванию года
      });
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  return out;
}
