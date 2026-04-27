// Cloudflare Worker — бэкенд БондАналитика.
//
// Сбор: акции (TQBR) + фьючерсы (FORTS) + облигации (TQCB корпораты,
// TQOB ОФЗ). На этом стенде строится basis для акций и spread-to-OFZ
// для бондов. Дополнительно — Cerebras-парсер для извлечения структуры
// из текстов отчётов / новостей / раскрытий.
//
// Endpoints:
//   GET  /status                       диагностика БД
//   GET  /stock/latest?limit=N         последние цены акций TQBR
//   GET  /stock/history?secid=SBER     история одной акции
//   GET  /futures/latest?asset=SBER    фьючерсы (все экспирации) на актив
//   GET  /basis?asset=SBER             текущий basis по ближайшему фьючерсу
//   GET  /basis/history?asset=SBER     история basis за всё время
//   GET  /bond/latest?board=TQCB       последний срез всех облигаций
//                    &limit=N&min_yield=&max_yield=
//                    &inn=&issuer=     фильтры по эмитенту
//   GET  /bond/history?secid=X         история одной облигации
//   GET  /bond/issuer?inn=X            все живые бумаги одного эмитента
//   POST /ai/extract                   извлечение структуры из текста
//                                      (X-Admin-Token, body: {text, schema, hints?})
//   POST /collect/stock                ручной сбор акций (X-Admin-Token)
//   POST /collect/futures              ручной сбор фьючерсов
//   POST /collect/bonds                ручной сбор облигаций
//
// Cron: 30 7 * * * (10:30 MSK) — собирает все три доски за раз.
//
// Basis = futures.price_rub - stock.price × lot_size
// В процентах: basis_pct = basis / (stock.price × lot_size) × 100
// Annualized basis (basis_ann) = basis_pct × (365 / days_to_expiry)
// Контанго (> 0) vs бэквордация (< 0) — отражает стоимость удержания
// позиции, дивидендные ожидания, спрос на спот/фьючерс.

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
  'Cache-Control': 'no-store',
};

const jsonResp = (data, status) =>
  new Response(JSON.stringify(data, null, 2), { status: status || 200, headers: JSON_HEADERS });
const errResp = (msg, status) => jsonResp({ error: msg }, status || 400);

export default {
  async fetch(req, env){
    const url = new URL(req.url);
    if(req.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });

    try {
      if(url.pathname === '/status')          return await handleStatus(env);
      if(url.pathname === '/stock/latest')    return await handleStockLatest(env, url);
      if(url.pathname === '/stock/history')   return await handleStockHistory(env, url);
      if(url.pathname === '/futures/latest')  return await handleFuturesLatest(env, url);
      if(url.pathname === '/basis')           return await handleBasis(env, url);
      if(url.pathname === '/basis/history')   return await handleBasisHistory(env, url);
      if(url.pathname === '/bond/latest')     return await handleBondLatest(env, url);
      if(url.pathname === '/bond/history')    return await handleBondHistory(env, url);
      if(url.pathname === '/bond/issuer')     return await handleBondIssuer(env, url);
      if(url.pathname === '/catalog')         return await handleCatalog(env);
      if(url.pathname.startsWith('/issuer/')) return await handleIssuerCard(env, url);

      if(req.method === 'POST'){
        // Все POST-эндпоинты требуют X-Admin-Token (используют квоту Cerebras
        // или пишут в БД — публиковать без авторизации опасно).
        const token = req.headers.get('X-Admin-Token') || '';
        if(!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return errResp('unauthorized', 401);
        if(url.pathname === '/collect/stock')    return jsonResp(await collectStocks(env));
        if(url.pathname === '/collect/futures')  return jsonResp(await collectFutures(env));
        if(url.pathname === '/collect/bonds')    return jsonResp(await collectBonds(env));
        if(url.pathname === '/collect/issuers')  return jsonResp(await collectIssuers(env));
        if(url.pathname === '/ai/extract')       return await handleAiExtract(env, req);
      }

      return errResp(
        'Not Found. Endpoints: /status, /stock/latest, /stock/history?secid=X, '
        + '/futures/latest?asset=X, /basis?asset=X, /basis/history?asset=X, '
        + '/bond/latest?board=TQCB, /bond/history?secid=X, /bond/issuer?inn=X, '
        + '/catalog, /issuer/:inn, '
        + 'POST /collect/{stock|futures|bonds|issuers}, POST /ai/extract',
        404
      );
    } catch(e){
      return errResp('internal: ' + (e.message || String(e)), 500);
    }
  },

  // Cron — ежедневный сбор всех досок. Справочник эмитентов
  // обновляем по понедельникам (новые ИНН/тикеры появляются медленно).
  async scheduled(event, env, ctx){
    ctx.waitUntil((async () => {
      try { await collectStocks(env); }   catch(e){ console.error('cron stocks:',  e.message); }
      try { await collectFutures(env); }  catch(e){ console.error('cron futures:', e.message); }
      try { await collectBonds(env); }    catch(e){ console.error('cron bonds:',   e.message); }
      const dow = new Date().getUTCDay(); // 0=Sun, 1=Mon
      if(dow === 1){
        try { await collectIssuers(env); } catch(e){ console.error('cron issuers:', e.message); }
      }
    })());
  },
};

// ═══ Endpoints ════════════════════════════════════════════════════════════

async function handleStatus(env){
  // Любая таблица может ещё не существовать при первом деплое —
  // оборачиваем каждый блок в try/catch, чтобы /status оставался живым.
  let bondStats = {};
  try {
    const [rb, lb, byBoard] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as c FROM bond_daily').first(),
      env.DB.prepare('SELECT MAX(date) as d FROM bond_daily').first(),
      env.DB.prepare("SELECT board, COUNT(DISTINCT secid) AS c FROM bond_daily GROUP BY board").all(),
    ]);
    bondStats = {
      bond_daily_rows: rb?.c ?? 0,
      bond_latest_date: lb?.d ?? null,
      bond_unique_by_board: Object.fromEntries((byBoard.results || []).map(r => [r.board, r.c])),
    };
  } catch(_){}

  let issuersStats = {};
  try {
    const [c, withTicker] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as c FROM issuers').first(),
      env.DB.prepare('SELECT COUNT(*) as c FROM issuers WHERE ticker IS NOT NULL').first(),
    ]);
    issuersStats = {
      issuers_count: c?.c ?? 0,
      issuers_with_ticker: withTicker?.c ?? 0,
    };
  } catch(_){}

  const [rowsStock, rowsFut, lastLog, latestStockDate, latestFutDate] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as c FROM stock_daily').first(),
    env.DB.prepare('SELECT COUNT(*) as c FROM futures_daily').first(),
    env.DB.prepare('SELECT * FROM collection_log ORDER BY started_at DESC LIMIT 8').all(),
    env.DB.prepare('SELECT MAX(date) as d FROM stock_daily').first(),
    env.DB.prepare('SELECT MAX(date) as d FROM futures_daily').first(),
  ]);
  return jsonResp({
    ok: true,
    db: {
      stock_daily_rows: rowsStock?.c ?? 0,
      stock_latest_date: latestStockDate?.d ?? null,
      futures_daily_rows: rowsFut?.c ?? 0,
      futures_latest_date: latestFutDate?.d ?? null,
      ...bondStats,
      ...issuersStats,
    },
    recent_runs: lastLog.results || [],
    cerebras_configured: !!env.CEREBRAS_API_KEY,
    version: '0.5-issuers',
  });
}

async function handleStockLatest(env, url){
  const limit = Math.min(1000, parseInt(url.searchParams.get('limit') || '500', 10));
  const rows = await env.DB.prepare(`
    SELECT s.*
    FROM stock_daily s
    INNER JOIN (
      SELECT secid, MAX(date) AS maxd FROM stock_daily GROUP BY secid
    ) m ON s.secid = m.secid AND s.date = m.maxd
    ORDER BY s.volume_rub DESC
    LIMIT ?
  `).bind(limit).all();
  return jsonResp({ count: rows.results.length, data: rows.results });
}

async function handleStockHistory(env, url){
  const secid = (url.searchParams.get('secid') || '').toUpperCase();
  if(!secid) return errResp('secid required');
  const from = url.searchParams.get('from') || '2020-01-01';
  const to   = url.searchParams.get('to')   || '2099-12-31';
  const rows = await env.DB.prepare(
    'SELECT date, price, prev_close, high_price, low_price, volume_rub FROM stock_daily WHERE secid = ? AND date BETWEEN ? AND ? ORDER BY date ASC'
  ).bind(secid, from, to).all();
  return jsonResp({ secid, count: rows.results.length, data: rows.results });
}

async function handleFuturesLatest(env, url){
  const asset = (url.searchParams.get('asset') || '').toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  let query = `
    SELECT f.*
    FROM futures_daily f
    INNER JOIN (
      SELECT secid, MAX(date) AS maxd FROM futures_daily GROUP BY secid
    ) m ON f.secid = m.secid AND f.date = m.maxd
    WHERE (f.last_delivery_date IS NULL OR f.last_delivery_date >= ?)
  `;
  const binds = [today];
  if(asset){ query += ' AND f.asset_code = ?'; binds.push(asset); }
  query += ' ORDER BY f.asset_code ASC, f.last_delivery_date ASC';
  const rows = await env.DB.prepare(query).bind(...binds).all();
  return jsonResp({ asset: asset || 'all', count: rows.results.length, data: rows.results });
}

// Текущий basis: спот-цена × lot_size и сравнение с ближайшим фьючерсом.
async function handleBasis(env, url){
  const asset = (url.searchParams.get('asset') || '').toUpperCase();
  if(!asset) return errResp('asset required, e.g. SBER / GAZP / LKOH');
  const today = new Date().toISOString().slice(0, 10);

  // Последняя цена акции
  const stock = await env.DB.prepare(
    'SELECT * FROM stock_daily WHERE secid = ? ORDER BY date DESC LIMIT 1'
  ).bind(asset).first();
  if(!stock) return errResp(`stock ${asset} not found — запустите /collect/stock или подождите cron`, 404);

  // Ближайший живой фьючерс по этому активу
  const fut = await env.DB.prepare(`
    SELECT * FROM futures_daily
    WHERE asset_code = ? AND last_delivery_date >= ?
    ORDER BY last_delivery_date ASC, date DESC
    LIMIT 1
  `).bind(asset, today).first();
  if(!fut) return errResp(`futures for ${asset} not found`, 404);

  const lotSize = fut.lot_size || 100;
  const spotValue = stock.price * lotSize;
  const futValue = fut.price;                 // цена фьючерса в рублях (обычно)
  const basis = futValue - spotValue;
  const basisPct = spotValue > 0 ? (basis / spotValue) * 100 : null;
  let daysToExpiry = null, basisAnn = null;
  if(fut.last_delivery_date){
    daysToExpiry = Math.max(1, Math.round((new Date(fut.last_delivery_date) - new Date(stock.date)) / 86400000));
    if(basisPct != null) basisAnn = basisPct * (365 / daysToExpiry);
  }

  return jsonResp({
    asset,
    stock: {
      secid: stock.secid, date: stock.date, price: stock.price, shortname: stock.shortname,
      spot_value_per_lot: spotValue,
    },
    futures: {
      secid: fut.secid, date: fut.date, price: fut.price, shortname: fut.shortname,
      expiry: fut.last_delivery_date, lot_size: lotSize,
    },
    basis: {
      rub: Math.round(basis * 100) / 100,
      pct: basisPct != null ? Math.round(basisPct * 1000) / 1000 : null,
      pct_annualized: basisAnn != null ? Math.round(basisAnn * 1000) / 1000 : null,
      days_to_expiry: daysToExpiry,
      direction: basis > 0 ? 'contango (фьючерс дороже спота)' : basis < 0 ? 'backwardation (фьючерс дешевле спота)' : 'flat',
    },
  });
}

// История basis: по каждой дате где есть и акция, и ближайший фьючерс,
// считаем basis. Отдаём временной ряд для построения графика.
async function handleBasisHistory(env, url){
  const asset = (url.searchParams.get('asset') || '').toUpperCase();
  if(!asset) return errResp('asset required');
  const from = url.searchParams.get('from') || '2020-01-01';
  const to   = url.searchParams.get('to')   || '2099-12-31';

  // Для каждой даты берём акцию + ближайший (по дате) живой фьючерс.
  // На SQLite это хорошо делается через коррелированный подзапрос.
  const rows = await env.DB.prepare(`
    SELECT
      s.date,
      s.price AS stock_price,
      f.secid AS fut_secid,
      f.price AS fut_price,
      f.lot_size AS lot_size,
      f.last_delivery_date AS expiry
    FROM stock_daily s
    JOIN futures_daily f ON f.date = s.date
    WHERE s.secid = ?
      AND f.asset_code = ?
      AND f.last_delivery_date >= s.date
      AND s.date BETWEEN ? AND ?
    GROUP BY s.date
    HAVING f.last_delivery_date = MIN(f.last_delivery_date)
    ORDER BY s.date ASC
  `).bind(asset, asset, from, to).all();

  const series = rows.results.map(r => {
    const lot = r.lot_size || 100;
    const spotVal = r.stock_price * lot;
    const basis = r.fut_price - spotVal;
    const basisPct = spotVal > 0 ? (basis / spotVal) * 100 : null;
    const d2e = Math.max(1, Math.round((new Date(r.expiry) - new Date(r.date)) / 86400000));
    const basisAnn = basisPct != null ? basisPct * (365 / d2e) : null;
    return {
      date: r.date, stock_price: r.stock_price, fut_price: r.fut_price,
      fut_secid: r.fut_secid, expiry: r.expiry,
      basis_rub: Math.round(basis * 100) / 100,
      basis_pct: basisPct != null ? Math.round(basisPct * 1000) / 1000 : null,
      basis_ann: basisAnn != null ? Math.round(basisAnn * 1000) / 1000 : null,
      days_to_expiry: d2e,
    };
  });
  return jsonResp({ asset, count: series.length, data: series });
}

// ═══ Endpoints: облигации ═════════════════════════════════════════════════

// Последний срез облигаций. Фильтры: board (TQCB/TQOB), доходность, объём,
// ИНН эмитента, поиск по имени. Сортировка по обороту (как у акций).
async function handleBondLatest(env, url){
  const limit    = Math.min(2000, parseInt(url.searchParams.get('limit') || '500', 10));
  const board    = (url.searchParams.get('board') || '').toUpperCase();
  const minYield = url.searchParams.get('min_yield');
  const maxYield = url.searchParams.get('max_yield');
  const inn      = url.searchParams.get('inn');
  const issuer   = url.searchParams.get('issuer');

  const where = ['s.date = m.maxd'];
  const binds = [];
  if(board)   { where.push('s.board = ?'); binds.push(board); }
  if(minYield){ where.push('s.yield >= ?'); binds.push(parseFloat(minYield)); }
  if(maxYield){ where.push('s.yield <= ?'); binds.push(parseFloat(maxYield)); }
  if(inn)     { where.push('s.emitent_inn = ?'); binds.push(String(inn)); }
  if(issuer)  { where.push('LOWER(s.emitent_name) LIKE ?'); binds.push('%' + String(issuer).toLowerCase() + '%'); }

  const sql = `
    SELECT s.*
    FROM bond_daily s
    INNER JOIN (
      SELECT secid, MAX(date) AS maxd FROM bond_daily GROUP BY secid
    ) m ON s.secid = m.secid
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(s.volume_rub, 0) DESC, s.yield DESC
    LIMIT ?
  `;
  binds.push(limit);
  const rows = await env.DB.prepare(sql).bind(...binds).all();
  return jsonResp({ count: rows.results.length, data: rows.results });
}

async function handleBondHistory(env, url){
  const secid = (url.searchParams.get('secid') || '').toUpperCase();
  if(!secid) return errResp('secid required, e.g. RU000A106DZ4');
  const from = url.searchParams.get('from') || '2020-01-01';
  const to   = url.searchParams.get('to')   || '2099-12-31';
  const rows = await env.DB.prepare(
    'SELECT date, price, prev_close, yield, duration_days, accrued_int, volume_rub, num_trades, status FROM bond_daily WHERE secid = ? AND date BETWEEN ? AND ? ORDER BY date ASC'
  ).bind(secid, from, to).all();
  return jsonResp({ secid, count: rows.results.length, data: rows.results });
}

async function handleBondIssuer(env, url){
  const inn = url.searchParams.get('inn');
  if(!inn) return errResp('inn required');
  const today = new Date().toISOString().slice(0, 10);
  const rows = await env.DB.prepare(`
    SELECT s.*
    FROM bond_daily s
    INNER JOIN (
      SELECT secid, MAX(date) AS maxd FROM bond_daily GROUP BY secid
    ) m ON s.secid = m.secid AND s.date = m.maxd
    WHERE s.emitent_inn = ?
      AND (s.mat_date IS NULL OR s.mat_date >= ?)
      AND (s.status IS NULL OR s.status = 'A')
    ORDER BY s.mat_date ASC
  `).bind(String(inn), today).all();
  return jsonResp({ inn, count: rows.results.length, data: rows.results });
}

// ═══ Endpoints: каталог для глобального поиска ════════════════════════════
//
// Собирает три плоских списка (компании, облигации, акции) из текущих
// таблиц D1 — фронт грузит этот JSON один раз, индексирует через fuse.js
// и фильтрует локально по ходу набора. Источник эмитентов — таблица
// issuers (если уже наполнена), иначе fallback на DISTINCT из bond_daily.

async function handleCatalog(env){
  const today = new Date().toISOString().slice(0, 10);
  let issuers = [], bonds = [], stocks = [];

  // эмитенты — пробуем сначала из справочника, иначе fallback
  try {
    const r = await env.DB.prepare(`
      SELECT inn, short_name AS name, ticker, sector, bonds_count, aliases
      FROM issuers
      WHERE inn IS NOT NULL
      ORDER BY short_name
    `).all();
    issuers = (r.results || []).map(x => ({
      ...x,
      aliases: x.aliases ? safeJsonParse(x.aliases, []) : null,
    }));
  } catch(_){}

  // fallback — если справочник пустой, агрегируем уникальные ИНН из bond_daily
  if(!issuers.length){
    try {
      const r = await env.DB.prepare(`
        SELECT emitent_inn AS inn,
               MAX(emitent_name) AS name,
               COUNT(DISTINCT secid) AS bonds_count
        FROM bond_daily
        WHERE emitent_inn IS NOT NULL AND emitent_inn != ''
          AND (mat_date IS NULL OR mat_date >= ?)
          AND (status IS NULL OR status = 'A')
        GROUP BY emitent_inn
        ORDER BY name
      `).bind(today).all();
      issuers = r.results || [];
    } catch(_){}
  }

  try {
    // последний срез живых облигаций
    const r = await env.DB.prepare(`
      SELECT s.secid       AS isin,
             s.emitent_inn AS issuerInn,
             s.shortname   AS name,
             s.yield       AS ytm,
             s.coupon_pct  AS coupon,
             s.mat_date    AS maturity,
             s.offer_date  AS offer,
             s.board       AS board
      FROM bond_daily s
      INNER JOIN (
        SELECT secid, MAX(date) AS maxd FROM bond_daily GROUP BY secid
      ) m ON s.secid = m.secid AND s.date = m.maxd
      WHERE (s.mat_date IS NULL OR s.mat_date >= ?)
        AND (s.status IS NULL OR s.status = 'A')
      ORDER BY COALESCE(s.volume_rub, 0) DESC
      LIMIT 8000
    `).bind(today).all();
    bonds = r.results || [];
  } catch(_){}

  try {
    // последний срез акций — change_pct считаем из price/prev_close
    const r = await env.DB.prepare(`
      SELECT s.secid     AS ticker,
             s.shortname AS name,
             s.price     AS price,
             s.prev_close AS prevClose,
             s.volume_rub AS volumeRub
      FROM stock_daily s
      INNER JOIN (
        SELECT secid, MAX(date) AS maxd FROM stock_daily GROUP BY secid
      ) m ON s.secid = m.secid AND s.date = m.maxd
      ORDER BY COALESCE(s.volume_rub, 0) DESC
    `).all();
    stocks = (r.results || []).map(x => ({
      ticker: x.ticker,
      name: x.name,
      price: x.price,
      changePct: (x.price && x.prevClose)
        ? Number((((x.price - x.prevClose) / x.prevClose) * 100).toFixed(2))
        : null,
    }));
  } catch(_){}

  return new Response(JSON.stringify({
    issuers, bonds, stocks,
    counts: { issuers: issuers.length, bonds: bonds.length, stocks: stocks.length },
    generatedAt: new Date().toISOString(),
  }), {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}

function safeJsonParse(s, fallback){
  try { return JSON.parse(s); } catch(_) { return fallback; }
}

// Карточка одного эмитента: справочные данные + активные выпуски +
// тикер акции, если есть. Используется фронтом при открытии Medium-окна.
async function handleIssuerCard(env, url){
  const inn = url.pathname.replace('/issuer/', '').split('/')[0];
  if(!inn || !/^\d{10,12}$/.test(inn)) return errResp('inn required, 10-12 digits, e.g. /issuer/7736050003');
  const today = new Date().toISOString().slice(0, 10);

  // справочные данные
  let issuer = null;
  try {
    const r = await env.DB.prepare('SELECT * FROM issuers WHERE inn = ?').bind(inn).first();
    if(r){
      issuer = { ...r, aliases: r.aliases ? safeJsonParse(r.aliases, null) : null };
    }
  } catch(_){}

  // имя из bond_daily — на случай если справочник ещё не наполнен
  if(!issuer){
    try {
      const r = await env.DB.prepare(
        'SELECT MAX(emitent_name) AS name FROM bond_daily WHERE emitent_inn = ?'
      ).bind(inn).first();
      if(r?.name) issuer = { inn, name: r.name, short_name: shortenIssuerName(r.name) };
    } catch(_){}
  }

  // активные облигации
  let bonds = [];
  try {
    const r = await env.DB.prepare(`
      SELECT s.secid, s.shortname, s.board, s.yield, s.coupon_pct, s.price,
             s.mat_date, s.offer_date, s.face_value, s.face_unit, s.list_level
      FROM bond_daily s
      INNER JOIN (
        SELECT secid, MAX(date) AS maxd FROM bond_daily GROUP BY secid
      ) m ON s.secid = m.secid AND s.date = m.maxd
      WHERE s.emitent_inn = ?
        AND (s.mat_date IS NULL OR s.mat_date >= ?)
        AND (s.status IS NULL OR s.status = 'A')
      ORDER BY s.mat_date ASC
    `).bind(inn, today).all();
    bonds = r.results || [];
  } catch(_){}

  // последняя цена акции по тикеру из справочника
  let stock = null;
  if(issuer?.ticker){
    try {
      const r = await env.DB.prepare(`
        SELECT s.secid AS ticker, s.shortname, s.price, s.prev_close, s.volume_rub, s.date
        FROM stock_daily s
        INNER JOIN (
          SELECT secid, MAX(date) AS maxd FROM stock_daily GROUP BY secid
        ) m ON s.secid = m.secid AND s.date = m.maxd
        WHERE s.secid = ?
      `).bind(issuer.ticker).first();
      if(r){
        stock = {
          ...r,
          changePct: (r.price && r.prev_close)
            ? Number((((r.price - r.prev_close) / r.prev_close) * 100).toFixed(2))
            : null,
        };
      }
    } catch(_){}
  }

  if(!issuer && !bonds.length) return errResp('issuer not found', 404);
  return jsonResp({ issuer, bonds, stock, generatedAt: new Date().toISOString() });
}

// ═══ Endpoints: AI-экстракция через Cerebras ══════════════════════════════
//
// Принимает текст (выжатый из PDF/DOCX/XLSX в браузере или сырой HTML
// раскрытия), возвращает структурированный JSON по выбранной схеме.
// Сейчас поддерживаются:
//   schema = 'report'   → финансовые показатели (rev/ebitda/np/...)
//   schema = 'event'    → корпоративное событие из e-disclosure
//   schema = 'supplier' → информация о контрагентах из MSFO-нот
//
// Cerebras — Llama 3.3 70B, ~2000 tokens/sec. Один отчёт парсится за
// 5-15 секунд. Free tier: 1M tokens/день, ~14400 запросов/день.

const CEREBRAS_BASE = 'https://api.cerebras.ai/v1';

async function callCerebras(env, prompt, opts){
  if(!env.CEREBRAS_API_KEY) throw new Error('CEREBRAS_API_KEY not set in Worker secrets');
  const model = opts?.model || 'llama-3.3-70b';
  const r = await fetch(CEREBRAS_BASE + '/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.CEREBRAS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: opts?.temperature ?? 0.1,
      max_tokens: opts?.max_tokens ?? 2000,
      response_format: { type: 'json_object' },
    }),
  });
  if(!r.ok){
    const errText = await r.text().catch(() => '');
    throw new Error(`Cerebras ${r.status}: ${errText.slice(0, 300)}`);
  }
  const j = await r.json();
  const content = j.choices?.[0]?.message?.content || '';
  return { content, usage: j.usage };
}

// Промпты по схемам — extracts function-style structured JSON.
function buildPrompt(schema, text, hints){
  const ctx = hints
    ? '\n\nКОНТЕКСТ ОТ ПОЛЬЗОВАТЕЛЯ:\n' + JSON.stringify(hints, null, 2)
    : '';

  if(schema === 'report'){
    return `Ты эксперт по финансовой отчётности. Извлеки из текста структурированные данные.${ctx}

ТЕКСТ ОТЧЁТА:
"""
${text.slice(0, 60000)}
"""

ВЕРНИ ТОЛЬКО JSON по схеме (без пояснений):
{
  "year": число (4 цифры) или null,
  "period": "Год" | "9М" | "Полугодие" | "1 квартал" | "3 квартал" | null,
  "type": "МСФО" | "РСБУ" | null,
  "currency": "RUB" | "USD" | "EUR",
  "unit_used": "млрд" | "млн" | "тыс" | "руб",
  "metrics": {
    "rev":    число (выручка)              или null,
    "ebitda": число (EBITDA)               или null,
    "ebit":   число (операц. прибыль)      или null,
    "np":     число (чистая прибыль)       или null,
    "int":    число (процентные расходы)   или null,
    "tax":    число (налог на прибыль)     или null,
    "assets": число (всего активов)        или null,
    "ca":     число (оборотные активы)     или null,
    "cl":     число (текущие обязательства) или null,
    "debt":   число (общий долг)           или null,
    "cash":   число (денежные средства)    или null,
    "ret":    число (нераспред. прибыль)   или null,
    "eq":     число (собственный капитал)  или null
  },
  "issuer_name": строка или null,
  "confidence": число от 0 до 1
}

ПРАВИЛА:
- ВСЕ суммы переводи в МЛРД ₽. Если в отчёте млн — делишь на 1000. Если тыс — на 1М.
- Если поле неоднозначно или отсутствует — null. НЕ УГАДЫВАЙ.
- "type": МСФО (международная) или РСБУ (российская). Если unclear — null.
- Возвращай ТОЛЬКО валидный JSON, никакого markdown или объяснений.`;
  }

  if(schema === 'event'){
    return `Извлеки из текста раскрытия корпоративное событие.${ctx}

ТЕКСТ:
"""
${text.slice(0, 30000)}
"""

ВЕРНИ JSON:
{
  "issuer_name": строка или null,
  "issuer_inn":  строка (10-12 цифр) или null,
  "event_date":  "YYYY-MM-DD" или null,
  "event_type":  "default" | "restructuring" | "rating_change" | "share_issue" |
                 "asset_sale" | "management_change" | "litigation" | "merger" |
                 "dividend" | "guidance_change" | "covenant_breach" | "other",
  "severity":    "critical" | "high" | "medium" | "low",
  "summary":     строка (1-2 предложения),
  "amount_rub":  число или null,
  "confidence":  число от 0 до 1
}`;
  }

  if(schema === 'supplier'){
    return `Извлеки из текста (раздел МСФО «Концентрация выручки/закупок» или аналог) информацию о контрагентах.${ctx}

ТЕКСТ:
"""
${text.slice(0, 40000)}
"""

ВЕРНИ JSON:
{
  "issuer_name": строка,
  "year":        число (4 цифры),
  "side":        "revenue" (мы продаём) | "costs" (мы покупаем),
  "edges": [
    {
      "counterparty_name": строка,
      "counterparty_inn":  строка или null,
      "share_pct":         число (доля контрагента в выручке/закупках, %)
    }
  ],
  "total_concentration_pct": число (сумма топ-N, %),
  "confidence": число от 0 до 1
}`;
  }

  throw new Error('Unknown schema: ' + schema + '. Supported: report | event | supplier');
}

async function handleAiExtract(env, req){
  let body;
  try { body = await req.json(); }
  catch(_){ return errResp('Invalid JSON body'); }

  const text = body?.text;
  const schema = body?.schema || 'report';
  const hints = body?.hints || null;

  if(!text || typeof text !== 'string') return errResp('text (string) required');
  if(text.length < 50) return errResp('text too short (need >50 chars)');
  if(text.length > 100000) return errResp('text too long (max 100K chars — отрежь до 60K и вызови повторно)');

  const t0 = Date.now();
  const prompt = buildPrompt(schema, text, hints);
  let raw;
  try {
    raw = await callCerebras(env, prompt);
  } catch(e){
    return errResp('Cerebras call failed: ' + e.message, 502);
  }

  // Llama 3.3 в JSON-mode возвращает строго валидный JSON, но на всякий
  // случай оборачиваем в try — иногда модель добавляет markdown-обёртку.
  let extracted;
  try {
    let jsonStr = raw.content.trim();
    // Убираем ```json ... ``` если LLM его добавила
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    extracted = JSON.parse(jsonStr);
  } catch(e){
    return jsonResp({
      ok: false,
      error: 'Failed to parse LLM JSON output',
      raw_response: raw.content.slice(0, 1000),
      duration_ms: Date.now() - t0,
    }, 500);
  }

  return jsonResp({
    ok: true,
    schema,
    extracted,
    usage: raw.usage,
    duration_ms: Date.now() - t0,
  });
}

// ═══ Коллекторы ═══════════════════════════════════════════════════════════

async function collectStocks(env){
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const base = env.MOEX_BASE || 'https://iss.moex.com';
  let rowsWritten = 0;
  const errors = [];

  try {
    const url = `${base}/iss/engines/stock/markets/shares/boards/TQBR/securities.json?iss.meta=off&iss.only=securities,marketdata`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' }, cf: { cacheTtl: 0 } });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    const parsed = parseStockPage(json);
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    for(const s of parsed){
      if(!s.secid) continue;
      const res = await env.DB.prepare(`
        INSERT INTO stock_daily (secid, date, shortname, price, prev_close, open_price, high_price, low_price, volume_rub, issue_size, face_value, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(secid, date) DO UPDATE SET
          shortname = excluded.shortname, price = excluded.price,
          prev_close = excluded.prev_close, open_price = excluded.open_price,
          high_price = excluded.high_price, low_price = excluded.low_price,
          volume_rub = excluded.volume_rub, issue_size = excluded.issue_size,
          face_value = excluded.face_value, updated_at = excluded.updated_at
      `).bind(
        s.secid, today, s.shortname, s.price, s.prevClose, s.open, s.high, s.low,
        s.volumeRub, s.issueSize, s.faceValue, now
      ).run();
      rowsWritten += res.meta?.rows_written || 0;
    }
  } catch(e){ errors.push(e.message); }

  await logRun(env, startedAt, 'moex_tqbr', rowsWritten, errors, Date.now() - t0);
  return { source: 'moex_tqbr', rowsWritten, errors, duration_ms: Date.now() - t0 };
}

async function collectFutures(env){
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const base = env.MOEX_BASE || 'https://iss.moex.com';
  let rowsWritten = 0;
  const errors = [];

  try {
    // FORTS — фьючерсы. Фильтруем только на акции (asset type).
    // Одной страницы обычно хватает на все живые контракты — ~100-200 шт.
    const url = `${base}/iss/engines/futures/markets/forts/securities.json?iss.meta=off&iss.only=securities,marketdata&assetcode=&limit=500`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' }, cf: { cacheTtl: 0 } });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    const parsed = parseFuturesPage(json);
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    for(const f of parsed){
      if(!f.secid) continue;
      const res = await env.DB.prepare(`
        INSERT INTO futures_daily (secid, date, asset_code, shortname, price, prev_close, last_delivery_date, step_price, min_step, lot_size, volume_rub, open_position, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(secid, date) DO UPDATE SET
          asset_code = excluded.asset_code, shortname = excluded.shortname,
          price = excluded.price, prev_close = excluded.prev_close,
          last_delivery_date = excluded.last_delivery_date,
          step_price = excluded.step_price, min_step = excluded.min_step,
          lot_size = excluded.lot_size, volume_rub = excluded.volume_rub,
          open_position = excluded.open_position, updated_at = excluded.updated_at
      `).bind(
        f.secid, today, f.assetCode, f.shortname, f.price, f.prevClose,
        f.lastDelivery, f.stepPrice, f.minStep, f.lotSize, f.volumeRub,
        f.openPos, now
      ).run();
      rowsWritten += res.meta?.rows_written || 0;
    }
  } catch(e){ errors.push(e.message); }

  await logRun(env, startedAt, 'moex_forts', rowsWritten, errors, Date.now() - t0);
  return { source: 'moex_forts', rowsWritten, errors, duration_ms: Date.now() - t0 };
}

// Собираем TQCB (корпорат) + TQOB (ОФЗ). MOEX отдаёт страницами по
// 100 строк по умолчанию, поэтому пагинация. Используем D1 batch чтобы
// ~2000 INSERT'ов поместились в один scheduled-вызов (CPU-time cron'а
// 30 сек, но без батча per-row INSERT нагрузка значительная).
async function collectBonds(env){
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const base = env.MOEX_BASE || 'https://iss.moex.com';
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  let rowsWritten = 0;
  const errors = [];

  // INSERT-шаблон вынесен — у D1 batch одинаковые prepared-statements
  // объединяются в одну транзакцию.
  const insertSql = `
    INSERT INTO bond_daily (
      secid, date, isin, shortname, board,
      price, prev_close, open_price, high_price, low_price,
      yield, duration_days, accrued_int,
      volume_rub, num_trades,
      face_value, face_unit, coupon_pct, coupon_value, coupon_period_days,
      next_coupon_date, mat_date, offer_date,
      issue_size, list_level, status,
      emitent_name, emitent_inn,
      updated_at
    )
    VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?, ?,?, ?,?,?,?,?, ?,?,?, ?,?,?, ?,?, ?)
    ON CONFLICT(secid, date) DO UPDATE SET
      isin=excluded.isin, shortname=excluded.shortname, board=excluded.board,
      price=excluded.price, prev_close=excluded.prev_close,
      open_price=excluded.open_price, high_price=excluded.high_price, low_price=excluded.low_price,
      yield=excluded.yield, duration_days=excluded.duration_days, accrued_int=excluded.accrued_int,
      volume_rub=excluded.volume_rub, num_trades=excluded.num_trades,
      face_value=excluded.face_value, face_unit=excluded.face_unit,
      coupon_pct=excluded.coupon_pct, coupon_value=excluded.coupon_value, coupon_period_days=excluded.coupon_period_days,
      next_coupon_date=excluded.next_coupon_date, mat_date=excluded.mat_date, offer_date=excluded.offer_date,
      issue_size=excluded.issue_size, list_level=excluded.list_level, status=excluded.status,
      emitent_name=excluded.emitent_name, emitent_inn=excluded.emitent_inn,
      updated_at=excluded.updated_at
  `;

  // TQCB корпораты (рубль), TQOB ОФЗ, TQIR валютные корпораты, TQOD юань,
  // TQOY юаневые суверены, TQED евробонды. Все эти доски парсятся
  // одной и той же функцией parseBondPage — поля одинаковые.
  for(const board of ['TQCB', 'TQOB', 'TQIR', 'TQOD', 'TQOY', 'TQED']){
    let start = 0;
    let pages = 0;
    const PAGE = 500;
    const MAX_PAGES = 8; // защита от бесконечной пагинации, ~4000 бумаг на доску
    try {
      while(pages < MAX_PAGES){
        const url = `${base}/iss/engines/stock/markets/bonds/boards/${board}/securities.json`
          + `?iss.meta=off&iss.only=securities,marketdata&start=${start}&limit=${PAGE}`;
        const r = await fetch(url, { headers: { 'Accept': 'application/json' }, cf: { cacheTtl: 0 } });
        if(!r.ok) throw new Error(`${board} HTTP ${r.status}`);
        const json = await r.json();
        const parsed = parseBondPage(json, board);
        if(!parsed.length) break;

        // D1 batch — все INSERT'ы одной страницы в одной транзакции
        const stmts = [];
        for(const b of parsed){
          if(!b.secid) continue;
          stmts.push(env.DB.prepare(insertSql).bind(
            b.secid, today, b.isin, b.shortname, board,
            b.price, b.prevClose, b.open, b.high, b.low,
            b.yield, b.duration, b.accruedInt,
            b.volumeRub, b.numTrades,
            b.faceValue, b.faceUnit, b.couponPct, b.couponValue, b.couponPeriod,
            b.nextCouponDate, b.matDate, b.offerDate,
            b.issueSize, b.listLevel, b.status,
            b.emitentName, b.emitentInn,
            now
          ));
        }
        if(stmts.length){
          const results = await env.DB.batch(stmts);
          rowsWritten += results.reduce((s, r) => s + (r.meta?.rows_written || 0), 0);
        }

        if(parsed.length < PAGE) break; // последняя страница
        start += parsed.length;
        pages++;
      }
    } catch(e){ errors.push(`${board}: ${e.message}`); }
  }

  await logRun(env, startedAt, 'moex_bonds', rowsWritten, errors, Date.now() - t0);
  return { source: 'moex_bonds', rowsWritten, errors, duration_ms: Date.now() - t0 };
}

// Сбор справочника эмитентов. Берём все ИНН, которые когда-либо
// упоминались в bond_daily, дополняем тем что знаем сами (имя из
// bond_daily, сектор пока пустой — в следующем коммите подтянем
// ОКВЭД из ГИР БО), пытаемся подбить тикер акции через MOEX
// issuer-card. Запускается раз в неделю — справочник меняется
// медленно (новые ИНН — это IPO/новые эмиссии).
async function collectIssuers(env){
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const base = env.MOEX_BASE || 'https://iss.moex.com';
  const now = new Date().toISOString();
  let rowsWritten = 0;
  const errors = [];

  // 1. Все живые ИНН из bond_daily с актуальными именами
  let raw = [];
  try {
    const r = await env.DB.prepare(`
      SELECT emitent_inn AS inn,
             MAX(emitent_name) AS name,
             COUNT(DISTINCT secid) AS bonds_count
      FROM bond_daily
      WHERE emitent_inn IS NOT NULL AND emitent_inn != ''
      GROUP BY emitent_inn
    `).all();
    raw = r.results || [];
  } catch(e){ errors.push('select inns: ' + e.message); }

  // 2. Подтянем тикеры акций: MOEX TQBR — последний срез stock_daily
  //    плюс попытка матчить по INN через MOEX `/iss/securities.json`
  //    (поиск по эмитенту), но это медленно, поэтому делаем минимум:
  //    matching по «самой узнаваемой подстроке» имени из bond_daily.
  //    Точнее обогатим при следующих проходах.
  let stockMap = {}; // shortname-prefix → ticker
  try {
    const r = await env.DB.prepare(`
      SELECT s.secid AS ticker, s.shortname AS name
      FROM stock_daily s
      INNER JOIN (
        SELECT secid, MAX(date) AS maxd FROM stock_daily GROUP BY secid
      ) m ON s.secid = m.secid AND s.date = m.maxd
    `).all();
    for(const row of (r.results || [])){
      if(!row.ticker || !row.name) continue;
      // нормализуем — короткое имя, нижний регистр, без префиксов
      const key = normalizeIssuerName(row.name);
      if(key && !stockMap[key]) stockMap[key] = row.ticker;
    }
  } catch(e){ errors.push('stocks for ticker matching: ' + e.message); }

  // 3. Пишем справочник, не затирая ручные правки (поля sector/okved/aliases
  //    обновляем только если они NULL — иначе уважаем существующее).
  const upsertSql = `
    INSERT INTO issuers (
      inn, name, short_name, ticker, bonds_count, source, updated_at
    ) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(inn) DO UPDATE SET
      name        = excluded.name,
      short_name  = excluded.short_name,
      bonds_count = excluded.bonds_count,
      ticker      = COALESCE(issuers.ticker, excluded.ticker),
      source      = COALESCE(issuers.source, excluded.source),
      updated_at  = excluded.updated_at
  `;
  const stmts = [];
  for(const row of raw){
    if(!row.inn) continue;
    const fullName  = row.name || '';
    const shortName = shortenIssuerName(fullName);
    const matchKey  = normalizeIssuerName(shortName);
    const ticker    = stockMap[matchKey] || null;
    stmts.push(env.DB.prepare(upsertSql).bind(
      row.inn, fullName, shortName, ticker, row.bonds_count || 0, 'moex', now
    ));
  }
  if(stmts.length){
    try {
      const results = await env.DB.batch(stmts);
      rowsWritten = results.reduce((s, r) => s + (r.meta?.rows_written || 0), 0);
    } catch(e){ errors.push('batch upsert: ' + e.message); }
  }

  await logRun(env, startedAt, 'issuers', rowsWritten, errors, Date.now() - t0);
  return { source: 'issuers', rowsWritten, errors, scanned: raw.length, duration_ms: Date.now() - t0 };
}

// Сократить имя: убрать ОПФ-префиксы и лишние «‎» — для дисплея и
// для матчинга со стоковым тикером.
function shortenIssuerName(name){
  if(!name) return '';
  let s = String(name).trim();
  // ОПФ-префиксы вначале
  s = s.replace(/^(публичное\s+акционерное\s+общество|открытое\s+акционерное\s+общество|закрытое\s+акционерное\s+общество|акционерное\s+общество|общество\s+с\s+ограниченной\s+ответственностью|пао|оао|зао|ао|ооо)\s+/i, '');
  // кавычки вокруг названия
  s = s.replace(/^[«"']+|[»"']+$/g, '').trim();
  return s || name;
}

// Нормализация для матчинга: нижний регистр, только буквы/цифры,
// первые два слова достаточно. «ПАО Газпром» и «GAZP — Газпром»
// сводятся к одному ключу.
function normalizeIssuerName(name){
  if(!name) return '';
  return shortenIssuerName(name)
    .toLowerCase()
    .replace(/[^a-zа-я0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ').slice(0, 2).join(' ');
}

async function logRun(env, startedAt, source, rowsWritten, errors, durationMs){
  const finishedAt = new Date().toISOString();
  const status = errors.length === 0 ? 'ok' : (rowsWritten > 0 ? 'partial' : 'error');
  await env.DB.prepare(
    'INSERT INTO collection_log (started_at, finished_at, source, status, rows_inserted, error, duration_ms) VALUES (?,?,?,?,?,?,?)'
  ).bind(startedAt, finishedAt, source, status, rowsWritten, errors.length ? errors.join(' | ') : null, durationMs).run();
}

// ═══ Парсеры MOEX ISS ═════════════════════════════════════════════════════

const _num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };

function parseStockPage(resp){
  const sec = resp.securities || {};
  const md  = resp.marketdata || {};
  const secCols = sec.columns || [], secData = sec.data || [];
  const mdCols  = md.columns  || [], mdData  = md.data  || [];
  const idx = (c, n) => c.indexOf(n);
  const sidIdx = idx(secCols, 'SECID');
  const mdSidIdx = idx(mdCols, 'SECID');
  const mdById = {};
  for(const r of mdData){ const id = r[mdSidIdx]; if(id) mdById[id] = r; }
  const out = [];
  for(const r of secData){
    const secid = r[sidIdx]; if(!secid) continue;
    const g  = n => r[idx(secCols, n)];
    const mdr = mdById[secid] || [];
    const gm = n => mdr[idx(mdCols, n)];
    out.push({
      secid,
      shortname: g('SHORTNAME') || g('SECNAME') || secid,
      price:      _num(gm('LAST')) || _num(g('PREVPRICE')) || _num(g('PREVLEGALCLOSEPRICE')),
      prevClose:  _num(gm('LCURRENTPRICE')) || _num(g('PREVPRICE')),
      open:       _num(gm('OPEN')),
      high:       _num(gm('HIGH')),
      low:        _num(gm('LOW')),
      volumeRub:  _num(gm('VALTODAY')) || _num(gm('VALTODAY_RUR')),
      issueSize:  _num(g('ISSUESIZE')),
      faceValue:  _num(g('FACEVALUE')),
    });
  }
  return out;
}

// MOEX `/iss/engines/stock/markets/bonds/boards/{TQCB|TQOB}/securities.json`
// возвращает два блока — securities (статика выпуска) и marketdata
// (последние сделки/котировки). Объединяем по SECID.
//
// Поля немного отличаются от акций. На корпоратах есть:
// COUPONPERCENT, COUPONVALUE, COUPONPERIOD, NEXTCOUPON, MATDATE, OFFERDATE,
// EMITENT_TITLE, EMITENT_INN. На marketdata: YIELD, DURATION, ACCRUEDINT.
function parseBondPage(resp, board){
  const sec = resp.securities || {};
  const md  = resp.marketdata || {};
  const secCols = sec.columns || [], secData = sec.data || [];
  const mdCols  = md.columns  || [], mdData  = md.data  || [];
  const idx = (c, n) => c.indexOf(n);
  const sidIdx = idx(secCols, 'SECID');
  const mdSidIdx = idx(mdCols, 'SECID');
  const mdById = {};
  for(const r of mdData){ const id = r[mdSidIdx]; if(id) mdById[id] = r; }

  // ISO-нормализация даты: MOEX иногда отдаёт '0000-00-00' для отсутствующих.
  const dnorm = v => (typeof v === 'string' && v.length >= 10 && !v.startsWith('0000')) ? v.slice(0, 10) : null;

  const out = [];
  for(const r of secData){
    const secid = r[sidIdx]; if(!secid) continue;
    const g  = n => r[idx(secCols, n)];
    const mdr = mdById[secid] || [];
    const gm = n => mdr[idx(mdCols, n)];

    out.push({
      secid,
      isin:        g('ISIN') || secid,
      shortname:   g('SHORTNAME') || g('SECNAME') || secid,
      // Цены: LAST → PREVPRICE → PREVLEGALCLOSEPRICE — fallback цепочка.
      // Для бондов цена обычно в % от номинала.
      price:       _num(gm('LAST')) || _num(g('PREVPRICE')) || _num(g('PREVLEGALCLOSEPRICE')),
      prevClose:   _num(g('PREVLEGALCLOSEPRICE')) || _num(g('PREVPRICE')),
      open:        _num(gm('OPEN')),
      high:        _num(gm('HIGH')),
      low:         _num(gm('LOW')),
      // Доходности и риск-метрики (только в marketdata)
      yield:       _num(gm('YIELD')),
      duration:    _num(gm('DURATION')),    // в днях
      accruedInt:  _num(gm('ACCRUEDINT')),  // НКД, ₽
      // Объёмы
      volumeRub:   _num(gm('VALTODAY')) || _num(gm('VALTODAY_RUR')),
      numTrades:   _num(gm('NUMTRADES')),
      // Параметры выпуска
      faceValue:    _num(g('FACEVALUE')),
      faceUnit:     g('FACEUNIT') || 'SUR',
      couponPct:    _num(g('COUPONPERCENT')),
      couponValue:  _num(g('COUPONVALUE')),
      couponPeriod: _num(g('COUPONPERIOD')),
      nextCouponDate: dnorm(g('NEXTCOUPON')),
      matDate:      dnorm(g('MATDATE')),
      offerDate:    dnorm(g('OFFERDATE')) || dnorm(g('BUYBACKDATE')),
      issueSize:    _num(g('ISSUESIZE')),
      listLevel:    _num(g('LISTLEVEL')),
      status:       g('STATUS') || null,
      // Эмитент. Для TQOB (ОФЗ) эмитент Минфин — оставляем как есть.
      emitentName:  g('EMITENT_TITLE') || g('LATNAME') || null,
      emitentInn:   g('EMITENT_INN') ? String(g('EMITENT_INN')) : null,
    });
  }
  return out;
}

function parseFuturesPage(resp){
  const sec = resp.securities || {};
  const md  = resp.marketdata || {};
  const secCols = sec.columns || [], secData = sec.data || [];
  const mdCols  = md.columns  || [], mdData  = md.data  || [];
  const idx = (c, n) => c.indexOf(n);
  const sidIdx = idx(secCols, 'SECID');
  const mdSidIdx = idx(mdCols, 'SECID');
  const mdById = {};
  for(const r of mdData){ const id = r[mdSidIdx]; if(id) mdById[id] = r; }
  const out = [];
  for(const r of secData){
    const secid = r[sidIdx]; if(!secid) continue;
    const g  = n => r[idx(secCols, n)];
    const mdr = mdById[secid] || [];
    const gm = n => mdr[idx(mdCols, n)];
    // Только фьючерсы на акции — asset_code обычно 4-значный тикер.
    const assetCode = g('ASSETCODE');
    if(!assetCode) continue;
    // Отсеиваем валюты, индексы, commodities — оставляем только акции.
    // У FORTS ASSETCODE для акционных фьючерсов совпадает с тикером
    // (SBER, GAZP, LKOH). Для валют — Si, Eu, RI. Простая эвристика —
    // только длинные (>=4 символа) и состоящие из букв.
    if(!/^[A-Z]{4,6}$/.test(assetCode)) continue;
    out.push({
      secid,
      assetCode,
      shortname: g('SHORTNAME') || g('SECNAME') || secid,
      price:       _num(gm('LAST')) || _num(g('PREVPRICE')) || _num(g('PREVSETTLEPRICE')),
      prevClose:   _num(g('PREVSETTLEPRICE')),
      lastDelivery: g('LASTDELDATE') || null,
      stepPrice:   _num(g('STEPPRICE')),
      minStep:     _num(g('MINSTEP')),
      lotSize:     _num(g('LOTVOLUME')) || 100,
      volumeRub:   _num(gm('VALTODAY')) || _num(gm('VALTODAY_RUR')),
      openPos:     _num(gm('OPENPOSITION')),
    });
  }
  return out;
}
