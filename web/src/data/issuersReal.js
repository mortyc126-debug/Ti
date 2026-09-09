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

// ROIC = NOPAT / инвестированный капитал = EBIT·(1−эфф.налог) / (капитал+долг−деньги).
// Единицы сокращаются (отношение), поэтому млн/млрд не важны.
function _roic(ebit, tax, np, eq, debt, cash){
  if(ebit == null) return null;
  const ic = (eq || 0) + (debt || 0) - (cash || 0);
  if(!(ic > 0)) return null;
  let t = 0.2;   // дефолтная ставка, если налог не дан
  if(tax != null && np != null && (np + tax) > 0) t = Math.min(0.5, Math.max(0, tax / (np + tax)));
  return ebit * (1 - t) / ic * 100;
}
const _ANNUAL = new Set(['FY', 'ГОД', '12М', '12M', 'Y']);

function _timeout(p, ms){
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

// сырая строка отчёта → мультипликаторы (ключи как в COMP_METRICS).
// Значения могут быть в млн или млрд ₽ — все метрики ниже это ОТНОШЕНИЯ,
// поэтому единица не важна. Проценты (ebitdaMarg/roa/ros) берём из готовых
// полей backend, а если их нет (снимок) — считаем из сырья.
export function reportToMults(r){
  const debt = _n(r.debt), eq = _n(r.eq), assets = _n(r.assets), ebitda = _n(r.ebitda),
        cash = _n(r.cash), ca = _n(r.ca), cl = _n(r.cl), intx = _n(r.int_exp),
        rev = _n(r.rev), np = _n(r.np), ebit = _n(r.ebit), tax = _n(r.tax_exp);
  // денежный поток (короткие ключи reportsDB и возможные ключи снимка)
  const cfo = _n(r.cfo) ?? _n(r.cfo_ops) ?? _n(r.op_cf),
        capex = _n(r.capex) ?? _n(r.capex_val),
        divp = _n(r.divp) ?? _n(r.div_paid);
  const fcf = (cfo != null && capex != null) ? cfo - capex : null;
  // оборотный капитал (база — выручка, COGS в данных нет)
  const recv = _n(r.recv), inv = _n(r.inv), pay = _n(r.pay);
  const dso = (recv != null && rev && rev > 0) ? recv / rev * 365 : null;
  const dio = (inv != null && rev && rev > 0) ? inv / rev * 365 : null;
  const dpo = (pay != null && rev && rev > 0) ? pay / rev * 365 : null;
  const ccc = (dso != null && dio != null && dpo != null) ? dso + dio - dpo : null;
  const m = {
    ebitdaMarg: _n(r.ebitda_marg) ?? ((rev && rev > 0 && ebitda != null) ? ebitda / rev * 100 : null),
    roa: _n(r.roa_pct) ?? ((assets && assets > 0 && np != null) ? np / assets * 100 : null),
    ros: _n(r.ros_pct) ?? ((rev && rev > 0 && np != null) ? np / rev * 100 : null),
    de: (ebitda && ebitda > 0 && debt != null) ? debt / ebitda : null,
    nde: (ebitda && ebitda > 0 && debt != null && cash != null) ? (debt - cash) / ebitda : null,
    icr: (intx && intx > 0 && ebitda != null) ? ebitda / intx : null,
    currentR: (cl && cl > 0 && ca != null) ? ca / cl : null,
    cashR: (cl && cl > 0 && cash != null) ? cash / cl : null,
    equityR: (eq != null && assets && assets > 0) ? eq / assets * 100 : null,
    roic: _roic(ebit, tax, np, eq, debt, cash),
    roe: (np != null && eq && eq > 0) ? np / eq * 100 : null,
    pe: null, yield: null,
    // денежный поток: FCF и производные (null, если нет ОДДС в данных)
    fcf,
    cfoConv: (cfo != null && ebitda && ebitda > 0) ? cfo / ebitda * 100 : null,   // конверсия EBITDA→кэш, %
    cfoNp: (cfo != null && np && np !== 0) ? cfo / np : null,                       // качество прибыли
    capexRev: (capex != null && rev && rev > 0) ? capex / rev * 100 : null,         // капиталоёмкость, %
    divFcf: (divp != null && fcf != null && fcf > 0) ? divp / fcf * 100 : null,     // покрытие дивидендов FCF, %
    // сырьё для мультипликаторов оценки акций (в тех же единицах, что пришли —
    // обычно млн); приведение делаем при расчёте
    npRaw: np, revRaw: rev, eqRaw: eq, debtRaw: debt, cashRaw: cash, ebitdaRaw: ebitda, assetsRaw: assets,
    cfoRaw: cfo, capexRaw: capex, divpRaw: divp, fcfRaw: fcf,
    dso, dio, dpo, ccc,
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

// Локальный снимок (web/public/reports-cache/{inn}.json = {data:[rows]},
// _index.json = [inn,...]) — тот же, что читает модуль отчётности. Живёт
// офлайн, не зависит от деградировавшей D1. Приоритет над backend.
async function _snapshotInns(){
  try {
    const r = await _timeout(fetch('/reports-cache/_index.json'), 8000);
    if(r.ok){ const a = await r.json(); if(Array.isArray(a) && a.length) return a.map(String); }
  } catch(_){}
  return null;
}
async function _fetchReportsSnap(inn){
  try {
    const r = await _timeout(fetch('/reports-cache/' + inn + '.json'), 8000);
    if(r.ok){ const d = await r.json(); return Array.isArray(d?.data) ? d.data : []; }
  } catch(_){}
  return [];
}

async function _fetchReportsBackend(inn){
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
  // Кто имеет отчёты: снимок → иначе backend report_years
  const snapInns = await _snapshotInns();
  let inns = snapInns;
  if(!inns){
    try { const ry = await _timeout(api.issuerReportYears(), 12000); inns = Object.keys(ry?.map || {}); }
    catch(_){ inns = []; }
  }
  if(!inns || !inns.length) return [];
  const fromSnap = !!snapInns;

  // имена/сектора — best-effort (тяжёлый /catalog кэширован на edge, с таймаутом)
  const meta = {};
  try {
    const cat = await _timeout(api.catalog(), 15000);
    for(const i of (cat?.issuers || [])){
      if(i.inn) meta[i.inn] = { name: i.name, ticker: i.ticker, sector: i.sector };
    }
  } catch(_){ /* без секторов → industry='other' */ }

  // per-issuer отчёты пулом (из снимка либо backend)
  const out = [];
  let idx = 0;
  const CONC = fromSnap ? 12 : 6;
  async function worker(){
    while(idx < inns.length){
      const inn = inns[idx++];
      const rows = fromSnap ? await _fetchReportsSnap(inn) : await _fetchReportsBackend(inn);
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
