// Прямые вызовы T-Invest API из браузера (как в модуле «Долг»,
// debtload.html). Токен берём из localStorage — он вводится в разделе
// «Долг» и живёт в том же origin. Наружу токен НЕ уходит: запросы идут
// только браузер → invest-public-api.tinkoff.ru. Токен нигде не логируем.

const TBASE = 'https://invest-public-api.tinkoff.ru/rest';
const V1 = 'tinkoff.public.invest.api.contract.v1.';

// Тот же набор ключей, что пишет debtload.html (основной + старые).
export function tinvestToken(){
  try {
    return localStorage.getItem('tinvest_token_v1')
      || localStorage.getItem('t_api_token')
      || localStorage.getItem('tinkoff_token')
      || '';
  } catch(_){ return ''; }
}

async function tFetch(method, body, tok){
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 12000);
  let res;
  try {
    res = await fetch(TBASE + '/' + V1 + method, {
      method: 'POST',
      // Только Content-Type + Authorization: любой доп. заголовок (напр.
      // x-app-name) добавляет его в CORS-preflight, а T-API его в
      // Access-Control-Allow-Headers не отдаёт → браузер рубит запрос.
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + tok,
      },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
  } catch(e){
    clearTimeout(tid);
    throw new Error(e.name === 'AbortError' ? 'таймаут' : String(e.message || e));
  }
  clearTimeout(tid);
  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); } catch(_){ throw new Error('ответ не JSON: ' + txt.slice(0, 80)); }
  if(res.status === 401) throw new Error('401 — токен недействителен');
  if(!res.ok) throw new Error('HTTP ' + res.status + ' ' + String(json.message || '').slice(0, 80));
  return json;
}

// Quotation/MoneyValue {units,nano} → число (nano всегда 1e-9).
const _q = q => q == null ? 0 : (parseInt(q.units) || 0) + (parseInt(q.nano) || 0) / 1e9;
const _money = _q;   // MoneyValue имеет ту же форму + currency

// figi → {isin,ticker,name}. Пара стабильна, кэшируем в localStorage, чтобы
// не дёргать InstrumentsService на каждый рендер.
const _FIGI_CACHE = 'ba_tinvest_figi_v1';
function _figiCacheGet(){ try { return JSON.parse(localStorage.getItem(_FIGI_CACHE) || '{}'); } catch(_){ return {}; } }
function _figiCacheSet(m){ try { localStorage.setItem(_FIGI_CACHE, JSON.stringify(m)); } catch(_){} }

async function _resolveFigi(figi, tok, cache){
  if(cache[figi]) return cache[figi];
  try {
    const d = await tFetch('InstrumentsService/GetInstrumentBy',
      { idType: 'INSTRUMENT_ID_TYPE_FIGI', id: figi }, tok);
    const i = d.instrument || {};
    const rec = { isin: (i.isin || '').toUpperCase(), ticker: i.ticker || null, name: i.name || null };
    cache[figi] = rec;
    return rec;
  } catch(_){ return { isin: null, ticker: null, name: null }; }
}

// ISIN → {inn, title, secid} эмитента через открытый MOEX ISS. Локального
// bonds-cache.json в сборке может не быть (fetch 404 → вселенная облигаций
// деградирует до мока), поэтому связь «бумага → эмитент» строим здесь по
// ISIN напрямую с биржи. emitent_inn → матчится с карточками эмитентов.
// Пара ISIN→ИНН стабильна, кэшируем в localStorage.
const _INN_CACHE = 'ba_isin_inn_v1';
function _innCacheGet(){ try { return JSON.parse(localStorage.getItem(_INN_CACHE) || '{}'); } catch(_){ return {}; } }
function _innCacheSet(m){ try { localStorage.setItem(_INN_CACHE, JSON.stringify(m)); } catch(_){} }

async function _moexByIsin(isin){
  try {
    const r = await fetch('https://iss.moex.com/iss/securities.json?iss.meta=off&iss.only=securities&limit=10&q=' + encodeURIComponent(isin));
    if(!r.ok) return {};
    const d = await r.json();
    const sec = d && d.securities;
    if(!sec || !sec.columns || !sec.data) return {};
    const ci = {}; sec.columns.forEach((c, i) => { ci[c] = i; });
    const up = isin.toUpperCase();
    const row = sec.data.find(x => String(x[ci.isin] || '').toUpperCase() === up) || sec.data[0];
    if(!row) return {};
    return {
      inn: row[ci.emitent_inn] != null ? String(row[ci.emitent_inn]) : null,
      title: row[ci.emitent_title] || null,
      secid: row[ci.secid] || null,
    };
  } catch(_){ return {}; }
}

// Дорезолвить ИНН для списка ISIN (с кэшем, пулом). Возвращает карту
// {ISIN(upper): {inn,title,secid}}.
export async function resolveInnsByIsin(isins){
  const cache = _innCacheGet();
  const todo = [...new Set(isins.filter(Boolean).map(s => s.toUpperCase()))].filter(k => !(k in cache));
  let idx = 0;
  const CONC = 5;
  async function w(){ while(idx < todo.length){ const k = todo[idx++]; cache[k] = await _moexByIsin(k); } }
  await Promise.all(Array.from({ length: CONC }, w));
  if(todo.length) _innCacheSet(cache);
  return cache;
}

// Все позиции со ВСЕХ счетов, дополненные isin/ticker/name. Берём только
// акции/облигации/ETF (валюта/фьючерсы к фундаменту эмитента не клеятся).
// Возвращает { ok, positions:[{isin,ticker,name,type,qty,accounts[]}], accounts, reason }.
export async function loadTinvestPositions(){
  const tok = tinvestToken();
  if(!tok) return { ok: false, reason: 'no-token', positions: [], accounts: [] };

  let accounts;
  try {
    const a = await tFetch('UsersService/GetAccounts', {}, tok);
    accounts = (a.accounts || []).filter(x => x.id);
  } catch(e){ return { ok: false, reason: String(e.message || e), positions: [], accounts: [] }; }
  if(!accounts.length) return { ok: true, positions: [], accounts: [] };

  // позиции со всех счетов, с ценами/НКД для расчёта стоимости и P&L
  const raw = [];
  for(const acc of accounts){
    try {
      const p = await tFetch('OperationsService/GetPortfolio', { accountId: acc.id }, tok);
      for(const pos of (p.positions || [])){
        const qty = _q(pos.quantity);
        if(!(qty > 0)) continue;   // нули/шорты пропускаем
        const it = String(pos.instrumentType || '').toLowerCase();
        if(it && !/bond|share|etf/.test(it)) continue;   // без валюты/фьючей
        const cur = String((pos.currentPrice && pos.currentPrice.currency) || 'rub').toLowerCase();
        if(cur !== 'rub') continue;   // приложение рублёвое — валютное пропускаем
        const avg = _money(pos.averagePositionPrice);   // ср. цена за 1 бумагу, ₽
        const last = _money(pos.currentPrice);           // текущая цена за 1 бумагу, ₽
        const nkd = _money(pos.currentNkd);              // НКД за 1 бумагу, ₽ (облигации)
        raw.push({
          figi: pos.figi, type: it, qty, name: null, account: acc.name || acc.id,
          avg, last, nkd,
          costRub: qty * avg,
          valRub: qty * (last + nkd),
        });
      }
    } catch(_){ /* один счёт упал — не валим остальные */ }
  }

  // figi → isin пулом (с кэшем)
  const cache = _figiCacheGet();
  const CONC = 6;
  let idx = 0;
  async function worker(){
    while(idx < raw.length){
      const r = raw[idx++];
      const m = await _resolveFigi(r.figi, tok, cache);
      r.isin = m.isin; r.ticker = m.ticker; r.name = r.name || m.name;
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  _figiCacheSet(cache);

  // схлопнуть одну бумагу с разных счетов в одну позицию (суммируем
  // qty/стоимость/затраты; ср. цена пересчитывается как costRub/qty)
  const byIsin = new Map();
  for(const r of raw){
    const k = r.isin || r.figi;
    const cur = byIsin.get(k);
    if(cur){
      cur.qty += r.qty; cur.costRub += r.costRub; cur.valRub += r.valRub;
      cur.accounts.add(r.account);
    } else {
      byIsin.set(k, {
        isin: r.isin, ticker: r.ticker, name: r.name, type: r.type,
        qty: r.qty, last: r.last, nkd: r.nkd,
        costRub: r.costRub, valRub: r.valRub, accounts: new Set([r.account]),
      });
    }
  }
  const positions = [...byIsin.values()].map(p => ({
    ...p,
    avg: p.qty ? p.costRub / p.qty : 0,
    pnlRub: p.valRub - p.costRub,
    accounts: [...p.accounts],
  }));
  // Привязка к эмитентам: ISIN → ИНН/название через MOEX (best-effort).
  try {
    const innMap = await resolveInnsByIsin(positions.map(p => p.isin));
    for(const p of positions){
      const m = p.isin ? innMap[p.isin.toUpperCase()] : null;
      if(m){ p.inn = m.inn || null; p.issuerTitle = m.title || null; p.moexSecid = m.secid || null; }
    }
  } catch(_){ /* нет связи с MOEX — позиции останутся без привязки */ }
  return { ok: true, positions, accounts: accounts.map(a => a.name || a.id) };
}
