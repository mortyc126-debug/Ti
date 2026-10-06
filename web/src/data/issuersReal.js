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

// reportsDB из модуля «Отчётность». База ПЕРЕЕХАЛА в IndexedDB
// (bondan_store/kv/reportsDB) — localStorage ~5 МБ её уже не вмещает, и
// ba_v2 при переполнении пишется БЕЗ reportsDB. Поэтому читаем сначала
// IndexedDB (источник истины), и только как запас — ba_v2. Без этого
// «Отрасли»/«Карта рынка» не видели ручные/импортированные эмитенты.
function _idbReadReportsDB(){
  return new Promise(resolve => {
    let done = false;
    const fin = v => { if(!done){ done = true; resolve(v); } };
    try {
      if(typeof indexedDB === 'undefined'){ fin(null); return; }
      const rq = indexedDB.open('bondan_store', 1);
      rq.onupgradeneeded = () => { try { rq.result.createObjectStore('kv'); } catch(_){} };
      rq.onerror = () => fin(null);
      rq.onsuccess = () => {
        try {
          const db = rq.result;
          if(!db.objectStoreNames.contains('kv')){ fin(null); return; }
          const g = db.transaction('kv', 'readonly').objectStore('kv').get('reportsDB');
          g.onsuccess = () => fin(g.result && typeof g.result === 'object' ? g.result : null);
          g.onerror = () => fin(null);
        } catch(_){ fin(null); }
      };
      setTimeout(() => fin(null), 6000);   // не вешаем загрузку, если IDB молчит
    } catch(_){ fin(null); }
  });
}

// Единая точка чтения reportsDB: IndexedDB → ba_v2 (обратная совместимость).
async function _readReportsDB(){
  const idb = await _idbReadReportsDB();
  if(idb && Object.keys(idb).length) return idb;
  try {
    const raw = localStorage.getItem('ba_v2');
    if(raw){ const db = JSON.parse(raw)?.reportsDB; if(db && Object.keys(db).length) return db; }
  } catch(_){}
  return idb || {};
}

// Имена эмитентов из reportsDB — тот же источник, что показывает модуль
// отчётности. db передаётся уже прочитанным (см. _readReportsDB).
// Возвращает { inn -> name }.
function _reportsDbNames(db){
  const map = {};
  try {
    for(const id in (db || {})){
      const e = db[id];
      if(!e || !e.name || !e.inn) continue;
      map[String(e.inn)] = e.name;
    }
  } catch(_){}
  return map;
}

// Ключи таксономии модуля отчётности (industry-peers.json) → ключи
// каталога React (industries.js), чтобы эмитенты из reportsDB правильно
// группировались в «Отраслях»/«Сравнении»/нормах (единая таксономия).
const _PEERS_IND_TO_REACT = {
  oil_gas: 'oil-gas', metals_mining: 'metals', metal_products: 'metalware', machinery: 'machinery',
  auto: 'auto', electronics: 'electronics', chemistry: 'chemistry', pharma: 'pharma',
  plastic_rubber: 'plastics', stroy_materials: 'building-mat', wood_paper: 'wood',
  textile_clothing: 'textile', furniture_other_mfg: 'furniture', agro_food: 'agro',
  utilities: 'utilities', construction: 'construction', real_estate: 'realestate', retail: 'retail',
  transport: 'logistics', hotels_catering: 'hospitality', media: 'media', telecom: 'telecom',
  it_software: 'it', banks: 'banks', insurance: 'insurance', leasing: 'leasing', mfi: 'mfo',
  holdings_spv: 'holdings', consulting: 'consulting', science_rnd: 'science', admin_services: 'rental',
  education: 'education', healthcare: 'healthcare', arts_sport: 'entertainment',
  other_services: 'services-etc', other: 'other',
};

// Годовые периоды reportsDB («Год»/FY/12М) с type РСБУ/МСФО.
const _REPDB_ANNUAL = new Set(['ГОД', 'FY', '12М', '12M', 'Y']);

// Приоритет периода, когда за год нет годового отчёта: берём самый
// «полный» по охвату (9М > Полугодие > 3 кв > 1 кв). Так компании,
// импортированные только поквартально/9М (credit-analyzer, smart-lab TTM),
// всё равно попадают в «Отрасли»/«Карту рынка», а не выпадают целиком.
function _periodRank(period){
  const p = String(period || '').trim().toUpperCase();
  if(_REPDB_ANNUAL.has(p)) return 5;
  if(/9\s*М|9M/.test(p)) return 4;
  if(/ПОЛУГОД|6\s*М|1П|H1/.test(p)) return 3;
  if(/3\s*КВ|Q3/.test(p)) return 2;
  if(/КВ|Q/.test(p)) return 1;
  return 0;
}
function _filledCount(p){
  let n = 0;
  for(const k in p){ const v = p[k]; if(typeof v === 'number' && isFinite(v)) n++; }
  return n;
}

// Короткие ключи периода reportsDB → поля, которые ждёт reportToMults.
// reportsDB хранит int/tax, а reportToMults читает int_exp/tax_exp. Единицы
// (всё в млрд ₽) не важны — метрики это отношения.
function _repPeriodToRow(p){
  return {
    rev: p.rev, ebitda: p.ebitda, ebit: p.ebit, np: p.np,
    int_exp: p.int, tax_exp: p.tax, assets: p.assets, ca: p.ca, cl: p.cl,
    debt: p.debt, cash: p.cash, eq: p.eq, cfo: p.cfo, capex: p.capex,
    divp: p.divp, recv: p.recv, inv: p.inv, pay: p.pay,
  };
}

// Карточки эмитентов прямо из reportsDB — авторитетный источник (ручной
// ввод/импорт пользователя). Форма как у backend-карточек: {id,inn,name,
// industry,kinds,reports:[{year,std,mults}]}. Благодаря этому «Отрасли» и
// «Карта рынка» показывают отчётность из модуля даже при мёртвом backend.
function _reportsDbIssuers(db){
  const out = [];
  for(const id in (db || {})){
    const iss = db[id];
    if(!iss || !iss.periods) continue;
    // Один отчёт на (год+тип): предпочитаем годовой, иначе самый полный
    // не-годовой период за этот год (9М/полугодие/квартал). Без этого
    // компании без годовой отчётности выпадали из списка целиком.
    const best = new Map();   // `${year}|${std}` → {period, p}
    for(const key in iss.periods){
      const p = iss.periods[key];
      if(!p || p.year == null) continue;
      const std = _normStd(p.type);
      const k = Number(p.year) + '|' + std;
      const cur = best.get(k);
      if(!cur){ best.set(k, p); continue; }
      const rNew = _periodRank(p.period), rCur = _periodRank(cur.period);
      // выше ранг периода, при равенстве — больше заполненных полей
      if(rNew > rCur || (rNew === rCur && _filledCount(p) > _filledCount(cur))) best.set(k, p);
    }
    if(!best.size) continue;
    const reps = [];
    for(const [k, p] of best){
      reps.push({ year: Number(k.split('|')[0]), std: k.split('|')[1], mults: reportToMults(_repPeriodToRow(p)) });
    }
    reps.sort((a, b) => b.year - a.year);
    const inn = iss.inn ? String(iss.inn) : null;
    out.push({
      id: inn || String(id), inn,
      name: iss.name || inn || String(id),
      ticker: null,
      industry: _PEERS_IND_TO_REACT[iss.ind] || iss.ind || 'other',
      kinds: ['bond'],
      reports: reps,
    });
  }
  return out;
}

// Имена эмитентов из снимка облигаций (bonds-cache.json несёт issuer+inn).
// Основной офлайн-источник имён, когда catalog деградировал, а reports-снимок
// имени не содержит. { inn -> issuerName }.
async function _bondNames(){
  const map = {};
  try {
    const r = await _timeout(fetch('/bonds-cache.json'), 8000);
    if(r.ok){
      const d = await r.json();
      const rows = Array.isArray(d) ? d : (Array.isArray(d?.data) ? d.data : []);
      for(const row of rows){
        const inn = row.inn || row.issuer_inn || row.emitent_inn;
        const nm = row.issuer || row.issuer_name || row.emitent || row.org_name;
        if(inn && nm && !map[String(inn)]) map[String(inn)] = nm;
      }
    }
  } catch(_){}
  return map;
}

// Готовый словарь имён {inn:name} из web/public/issuer-names.json
// (генерится tools/make_issuer_names.py из MOEX). Главный офлайн-источник имён.
async function _issuerNamesFile(){
  try {
    const r = await _timeout(fetch('/issuer-names.json'), 8000);
    if(r.ok){ const d = await r.json(); if(d && typeof d === 'object') return d; }
  } catch(_){}
  return {};
}

// Имена из отраслевого справочника (offline, без MOEX): web/public/
// industry-peers.json (сид) + localStorage['bondan_industry_peers'] (правки
// пользователя со страницы «Отрасли»). Структура: {industries:{k:{peers:[{inn,name}]}}}.
async function _peerNames(){
  const map = {};
  const collect = obj => {
    const inds = obj?.industries || {};
    for(const k in inds){ for(const p of (inds[k]?.peers || [])){ if(p?.inn && p?.name) map[String(p.inn)] = p.name; } }
  };
  try { const r = await _timeout(fetch('/industry-peers.json'), 8000); if(r.ok) collect(await r.json()); } catch(_){}
  try { const raw = localStorage.getItem('bondan_industry_peers'); if(raw) collect(JSON.parse(raw)); } catch(_){}
  return map;
}

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
    if(r.ok){
      const d = await r.json();
      const data = Array.isArray(d?.data) ? d.data : (Array.isArray(d) ? d : []);
      // имя эмитента из снимка (catalog деградировал — иначе останутся ИНН-цифры)
      const row0 = data[0] || {};
      const name = d?.name || d?.orgName || d?.org || d?.issuer || d?.short_name
        || row0.name || row0.org || row0.orgName || row0.issuer || row0.short_name || null;
      return { data, name };
    }
  } catch(_){}
  return { data: [], name: null };
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
  // reportsDB модуля «Отчётность» — читаем первым: это ручные/импортированные
  // данные пользователя, их показываем даже когда backend/снимок пусты.
  const repDb = await _readReportsDB();
  const repIssuers = _reportsDbIssuers(repDb);

  // Слить reportsDB-эмитентов в список: перекрывают backend по inn/id и
  // добавляют отсутствующих (банки, ручной импорт и т.п.).
  const _mergeRep = (list) => {
    if(!repIssuers.length) return list;
    const byKey = new Map(list.map(o => [String(o.inn || o.id), o]));
    for(const ri of repIssuers) byKey.set(String(ri.inn || ri.id), ri);
    return [...byKey.values()];
  };

  // Кто имеет отчёты: снимок → иначе backend report_years
  const snapInns = await _snapshotInns();
  let inns = snapInns;
  if(!inns){
    try { const ry = await _timeout(api.issuerReportYears(), 12000); inns = Object.keys(ry?.map || {}); }
    catch(_){ inns = []; }
  }
  if(!inns || !inns.length) return _mergeRep([]);   // backend мёртв — отдаём хотя бы reportsDB
  const fromSnap = !!snapInns;

  // имена/сектора — best-effort (тяжёлый /catalog кэширован на edge, с таймаутом)
  const meta = {};
  try {
    const cat = await _timeout(api.catalog(), 15000);
    for(const i of (cat?.issuers || [])){
      if(i.inn) meta[i.inn] = { name: i.name, ticker: i.ticker, sector: i.sector };
    }
  } catch(_){ /* без секторов → industry='other' */ }

  // имена из reportsDB и снимка облигаций — на случай, если catalog
  // пуст/деградировал, а reports-снимок имени не содержит
  const dbNames = _reportsDbNames(repDb);
  const bondNames = await _bondNames();
  const fileNames = await _issuerNamesFile();
  const peerNames = await _peerNames();

  // per-issuer отчёты пулом (из снимка либо backend)
  const out = [];
  let idx = 0;
  const CONC = fromSnap ? 12 : 6;
  async function worker(){
    while(idx < inns.length){
      const inn = inns[idx++];
      const snap = fromSnap ? await _fetchReportsSnap(inn) : { data: await _fetchReportsBackend(inn), name: null };
      const rows = snap.data;
      const reps = _annualReports(rows);
      if(!reps.length) continue;
      const mm = meta[inn] || {};
      out.push({
        id: inn, inn,
        // приоритет: catalog → reports-снимок → reportsDB → отраслевой
        // справочник (offline) → словарь MOEX → снимок облигаций → ИНН
        name: mm.name || snap.name || dbNames[String(inn)] || peerNames[String(inn)]
          || fileNames[String(inn)] || bondNames[String(inn)] || inn,
        ticker: mm.ticker || null,
        industry: _SECTOR_MAP[mm.sector] || mm.sector || 'other',
        kinds: ['bond'],
        reports: reps,            // [{year, std, mults}] по убыванию года
      });
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  return _mergeRep(out);
}
