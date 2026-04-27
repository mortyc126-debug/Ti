// Cloudflare Worker — бэкенд БондАналитика.
//
// Сбор: акции (TQBR) + фьючерсы (FORTS) + облигации (TQCB/TQOB/TQOD/TQOY)
// + справочник эмитентов (MOEX bulk + emitter card) + РСБУ-показатели
// по каскаду источников: ГИР БО (bo.nalog.gov.ru) → buxbalans.ru.
// Каскад срабатывает если первый источник не отдал ожидаемый последний
// год (старые отчёты не блокируют поиск новых). Дополнительно —
// Cerebras-парсер для извлечения структуры из текстов отчётов / новостей.
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
//   GET  /issuer/:inn                  карточка эмитента (имя, бумаги, акция)
//   GET  /issuer/:inn/reports          годовые РСБУ-показатели из ГИР БО
//   GET  /reports/latest?limit=N       свежие отчёты у эмитентов
//   POST /ai/extract                   извлечение структуры из текста
//                                      (X-Admin-Token, body: {text, schema, hints?})
//   POST /collect/stock                ручной сбор акций (X-Admin-Token)
//   POST /collect/futures              ручной сбор фьючерсов
//   POST /collect/bonds                ручной сбор облигаций
//   POST /collect/issuers              справочник эмитентов: bulk-обогащение
//                                      bond_daily.emitent_inn + issuers
//   POST /collect/reports?limit=20     РСБУ-показатели по каскаду
//                                      ГИР БО → buxbalans для следующих N
//                                      ИНН в очереди.
//                                      ?only_traded=1 — только эмитенты
//                                      с активными бумагами в bond_daily.
//                                      ?force=1 — игнорировать «свежие»
//                                      и прогнать заново.
//                                      ?inn=X — обработать конкретный ИНН.
//
// Cron: 30 7 * * * (10:30 MSK) — стандартный сбор досок и обогащение
// эмитентов; раз в сутки также подтягивает по 50 ИНН из reports_queue.
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
      if(url.pathname === '/reports/latest')  return await handleReportsLatest(env, url);
      if(url.pathname.startsWith('/issuer/')){
        // /issuer/:inn        — карточка
        // /issuer/:inn/reports — годовые РСБУ-показатели
        if(url.pathname.endsWith('/reports')) return await handleIssuerReports(env, url);
        return await handleIssuerCard(env, url);
      }

      if(req.method === 'POST'){
        // Все POST-эндпоинты требуют X-Admin-Token (используют квоту Cerebras
        // или пишут в БД — публиковать без авторизации опасно).
        const token = req.headers.get('X-Admin-Token') || '';
        if(!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return errResp('unauthorized', 401);
        if(url.pathname === '/collect/stock')    return jsonResp(await collectStocks(env));
        if(url.pathname === '/collect/futures')  return jsonResp(await collectFutures(env));
        if(url.pathname === '/collect/bonds')    return jsonResp(await collectBonds(env));
        if(url.pathname === '/collect/issuers')  return jsonResp(await collectIssuers(env, url));
        if(url.pathname === '/collect/reports')  return jsonResp(await collectReports(env, url));
        if(url.pathname === '/ai/extract')       return await handleAiExtract(env, req);
      }

      return errResp(
        'Not Found. Endpoints: /status, /stock/latest, /stock/history?secid=X, '
        + '/futures/latest?asset=X, /basis?asset=X, /basis/history?asset=X, '
        + '/bond/latest?board=TQCB, /bond/history?secid=X, /bond/issuer?inn=X, '
        + '/catalog, /issuer/:inn, /issuer/:inn/reports, /reports/latest, '
        + 'POST /collect/{stock|futures|bonds|issuers|reports}, POST /ai/extract',
        404
      );
    } catch(e){
      return errResp('internal: ' + (e.message || String(e)), 500);
    }
  },

  // Cron — ежедневный сбор. Доски TQBR/FORTS/bonds — каждый день, плюс
  // обогащение справочника эмитентов (collectIssuers — bulk MOEX,
  // быстрый, без квоты ФНС). По понедельникам — догрузка отчётности
  // ГИР БО (REPORTS_BATCH = 50 эмитентов за раз, остальные подтянутся
  // в следующие недели через очередь reports_queue).
  async scheduled(event, env, ctx){
    ctx.waitUntil((async () => {
      try { await collectStocks(env); }   catch(e){ console.error('cron stocks:',  e.message); }
      try { await collectFutures(env); }  catch(e){ console.error('cron futures:', e.message); }
      try { await collectBonds(env); }    catch(e){ console.error('cron bonds:',   e.message); }
      // Эмитентов обогащаем каждый день — bulk-вызов MOEX дешёвый,
      // а без него bond_daily.emitent_inn остаётся пустым и ничего
      // не показывается в каталоге.
      try { await collectIssuers(env); }  catch(e){ console.error('cron issuers:', e.message); }
      const dow = new Date().getUTCDay(); // 0=Sun, 1=Mon
      if(dow === 1){
        try {
          await collectReports(env, new URL('https://x/?limit=50'));
        } catch(e){ console.error('cron reports:', e.message); }
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
    const [c, withTicker, withInn] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as c FROM issuers').first(),
      env.DB.prepare('SELECT COUNT(*) as c FROM issuers WHERE ticker IS NOT NULL').first(),
      env.DB.prepare("SELECT COUNT(*) as c FROM bond_daily WHERE date = (SELECT MAX(date) FROM bond_daily) AND emitent_inn IS NOT NULL AND emitent_inn != ''").first(),
    ]);
    issuersStats = {
      issuers_count: c?.c ?? 0,
      issuers_with_ticker: withTicker?.c ?? 0,
      bonds_with_inn_today: withInn?.c ?? 0,
    };
  } catch(_){}

  // Статистика по отчётности: сколько ИНН покрыто, последние fetched_at.
  let reportsStats = {};
  try {
    const [rRows, rIssuers, rRecent, qPending, bySrc] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as c FROM issuer_reports').first(),
      env.DB.prepare('SELECT COUNT(DISTINCT inn) as c FROM issuer_reports').first(),
      env.DB.prepare('SELECT MAX(fetched_at) as t FROM issuer_reports').first(),
      env.DB.prepare("SELECT COUNT(*) as c FROM reports_queue WHERE last_success IS NULL OR last_success < datetime('now', '-30 days')").first(),
      env.DB.prepare('SELECT source, COUNT(*) AS c FROM issuer_reports GROUP BY source').all(),
    ]);
    reportsStats = {
      reports_rows: rRows?.c ?? 0,
      reports_issuers_covered: rIssuers?.c ?? 0,
      reports_last_fetched: rRecent?.t ?? null,
      reports_queue_pending: qPending?.c ?? 0,
      reports_by_source: Object.fromEntries((bySrc.results || []).map(r => [r.source, r.c])),
    };
  } catch(_){}

  // AI-статистика — за сегодня и за месяц
  let aiStats = {};
  try {
    const [calls24h, calls30d, tokens30d, cacheHit24h] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) as c FROM ai_calls_log WHERE called_at >= datetime('now', '-1 day')").first(),
      env.DB.prepare("SELECT COUNT(*) as c FROM ai_calls_log WHERE called_at >= datetime('now', '-30 days')").first(),
      env.DB.prepare("SELECT COALESCE(SUM(tokens_in),0) as i, COALESCE(SUM(tokens_out),0) as o FROM ai_calls_log WHERE called_at >= datetime('now', '-30 days')").first(),
      env.DB.prepare("SELECT COUNT(*) as c FROM ai_calls_log WHERE called_at >= datetime('now', '-1 day') AND cache_hit = 1").first(),
    ]);
    aiStats = {
      ai_calls_24h: calls24h?.c ?? 0,
      ai_calls_30d: calls30d?.c ?? 0,
      ai_tokens_in_30d: tokens30d?.i ?? 0,
      ai_tokens_out_30d: tokens30d?.o ?? 0,
      ai_cache_hits_24h: cacheHit24h?.c ?? 0,
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
      ...reportsStats,
    },
    recent_runs: lastLog.results || [],
    cerebras_configured: !!env.CEREBRAS_API_KEY,
    xai_configured: !!env.XAI_API_KEY,
    ...aiStats,
    version: '0.8-ai-cascade',
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

  // Последние 3 года РСБУ-показателей из issuer_reports — чтобы фронт
  // мог в одном запросе показать «выручка / прибыль / долг» под именем.
  let reports = [];
  try {
    const r = await env.DB.prepare(`
      SELECT fy_year, period, std, rev, ebitda, ebit, np,
             assets, debt, cash, eq,
             roa_pct, ros_pct, ebitda_marg, net_debt_eq,
             source, fetched_at
      FROM issuer_reports
      WHERE inn = ?
      ORDER BY fy_year DESC
      LIMIT 5
    `).bind(inn).all();
    reports = r.results || [];
  } catch(_){}

  return jsonResp({ issuer, bonds, stock, reports, generatedAt: new Date().toISOString() });
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
const XAI_BASE      = 'https://api.x.ai/v1';

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

// xAI Grok через OpenAI-совместимый chat/completions. Ключевая фича для
// нас — `search_parameters` (Live Search): Grok сам ходит в открытый
// интернет (e-disclosure, audit-it, новости) и вытаскивает данные. Это
// именно «другие пути» из ТЗ, когда ГИР БО + buxbalans не сработали.
//
// Модель по умолчанию — `grok-4` (с reasoning), но это медленно/дорого.
// Для массового сбора пользуемся `grok-4-fast-reasoning` (быстрее в ~3x).
// Для коротких событий из новостей — `grok-3-mini` (минимально-дёшево).
async function callXai(env, prompt, opts){
  if(!env.XAI_API_KEY) throw new Error('XAI_API_KEY not set in Worker secrets');
  const model = opts?.model || 'grok-4-fast-reasoning';
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: opts?.temperature ?? 0.1,
    max_tokens: opts?.max_tokens ?? 3000,
    response_format: { type: 'json_object' },
  };
  // Live Search включается явно. По умолчанию — auto (модель сама
  // решит, нужен ли поиск). Для report-схемы всегда полезен → 'on'.
  if(opts?.search !== false){
    body.search_parameters = {
      mode: opts?.search || 'auto',
      max_search_results: opts?.max_search_results || 5,
    };
  }
  const r = await fetch(XAI_BASE + '/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.XAI_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if(!r.ok){
    const errText = await r.text().catch(() => '');
    throw new Error(`xAI ${r.status}: ${errText.slice(0, 300)}`);
  }
  const j = await r.json();
  const content = j.choices?.[0]?.message?.content || '';
  return { content, usage: j.usage, citations: j.citations || [] };
}

// Универсальная обёртка: kind = 'cerebras' | 'grok'. Логирует вызов в
// ai_calls_log, при необходимости кладёт в ai_cache. Кеш-ключ —
// sha256('{engine}|{schema}|{cacheKey}').
async function callAi(env, engine, prompt, opts){
  const t0 = Date.now();
  const schema = opts?.schema || 'free';
  const inn = opts?.inn || null;
  const cacheTtlDays = opts?.cacheTtlDays || 30;

  // Кеш-lookup
  let cacheKey = null;
  if(opts?.cacheKey){
    cacheKey = await sha256(`${engine}|${schema}|${opts.cacheKey}`);
    try {
      const hit = await env.DB.prepare(
        `SELECT response, tokens_in, tokens_out FROM ai_cache
          WHERE cache_key = ? AND ttl_until >= datetime('now')`
      ).bind(cacheKey).first();
      if(hit){
        await logAiCall(env, engine, schema, inn, true, true, hit.tokens_in, hit.tokens_out, Date.now() - t0, null);
        return { content: hit.response, usage: { prompt_tokens: hit.tokens_in, completion_tokens: hit.tokens_out }, cache_hit: true };
      }
    } catch(_){ /* нет таблицы — игнор */ }
  }

  let res;
  try {
    res = engine === 'grok'
      ? await callXai(env, prompt, opts)
      : await callCerebras(env, prompt, opts);
  } catch(e){
    await logAiCall(env, engine, schema, inn, false, false, null, null, Date.now() - t0, e.message);
    throw e;
  }
  const tIn  = res.usage?.prompt_tokens     ?? null;
  const tOut = res.usage?.completion_tokens ?? null;
  await logAiCall(env, engine, schema, inn, true, false, tIn, tOut, Date.now() - t0, null);

  // Кеш-write
  if(cacheKey){
    try {
      await env.DB.prepare(`
        INSERT INTO ai_cache (cache_key, engine, schema, inn, response, tokens_in, tokens_out, fetched_at, ttl_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', ?))
        ON CONFLICT(cache_key) DO UPDATE SET
          response   = excluded.response,
          tokens_in  = excluded.tokens_in,
          tokens_out = excluded.tokens_out,
          fetched_at = excluded.fetched_at,
          ttl_until  = excluded.ttl_until
      `).bind(
        cacheKey, engine, schema, inn, res.content, tIn, tOut,
        `+${cacheTtlDays} days`
      ).run();
    } catch(_){ /* нет таблицы — игнор */ }
  }

  return res;
}

async function logAiCall(env, engine, schema, inn, ok, cacheHit, tIn, tOut, durMs, err){
  try {
    await env.DB.prepare(`
      INSERT INTO ai_calls_log (engine, schema, inn, ok, cache_hit, tokens_in, tokens_out, duration_ms, error, called_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(engine, schema, inn, ok ? 1 : 0, cacheHit ? 1 : 0, tIn, tOut, durMs, err ? String(err).slice(0, 300) : null).run();
  } catch(_){ /* нет таблицы — игнор */ }
}

// SHA-256 hex (Web Crypto, доступен в Workers без импортов).
async function sha256(input){
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
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
  // engine = 'cerebras' (default, быстро и дёшево) | 'grok' (с Live Search,
  // полезно когда text — это не сам отчёт, а описание/ссылка/выжимка).
  const engine = (body?.engine || 'cerebras').toLowerCase();
  if(!['cerebras', 'grok'].includes(engine)){
    return errResp('engine must be cerebras|grok');
  }

  if(!text || typeof text !== 'string') return errResp('text (string) required');
  if(text.length < 50) return errResp('text too short (need >50 chars)');
  if(text.length > 100000) return errResp('text too long (max 100K chars — отрежь до 60K и вызови повторно)');

  const t0 = Date.now();
  const prompt = buildPrompt(schema, text, hints);
  let raw;
  try {
    raw = await callAi(env, engine, prompt, {
      schema,
      // Для одинаковых текстов (повторные парсы) — лезем в кеш на 7 дней.
      // Текст может быть длинным, но в ключ кладём sha256 целого payload'а.
      cacheKey: text.slice(0, 200) + '|' + (hints ? JSON.stringify(hints) : ''),
      cacheTtlDays: 7,
    });
  } catch(e){
    return errResp(`${engine} call failed: ${e.message}`, 502);
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
    engine,
    extracted,
    usage: raw.usage,
    cache_hit: !!raw.cache_hit,
    citations: raw.citations || null,
    duration_ms: Date.now() - t0,
  });
}

// ═══ Grok-fallback для отчётности ═════════════════════════════════════
//
// Третий уровень каскада в collectReports. Используется ТОЛЬКО когда:
//   1. ГИР БО и buxbalans уже не дали свежий год для этого ИНН;
//   2. У эмитента есть активные торгуемые бумаги (is_traded=1);
//   3. В env есть XAI_API_KEY;
//   4. AI-бюджет на текущий прогон ещё не исчерпан.
//
// Grok с Live Search умеет ходить в открытый интернет (e-disclosure.ru,
// audit-it.ru, новости, годовые отчёты), что закрывает «другие пути» из
// ТЗ для эмитентов, у которых ФНС не выкатила и/или buxbalans не успел.
async function xaiFetchByInn(inn, opts){
  const env = opts?.env;
  if(!env?.XAI_API_KEY) throw new Error('XAI_API_KEY not set');
  const expected = expectedFyYear(new Date());

  // Подтащим имя эмитента для контекста, чтобы Grok искал не по
  // сухому ИНН а по «Дельтакапиталресурс ИНН 7728…».
  let name = `ИНН ${inn}`;
  let ticker = null;
  try {
    const row = await env.DB.prepare(
      'SELECT name, short_name, ticker FROM issuers WHERE inn = ?'
    ).bind(inn).first();
    if(row){
      name = row.short_name || row.name || name;
      ticker = row.ticker || null;
    }
  } catch(_){}

  const prompt = `Ты помогаешь собирать РСБУ-отчётность российских эмитентов облигаций.

ЭМИТЕНТ:
  ИНН: ${inn}
  Название: ${name}${ticker ? '\n  Тикер: ' + ticker : ''}

ЗАДАЧА: найди в открытых источниках (e-disclosure.ru, audit-it.ru,
buxbalans.ru, годовые отчёты на сайте эмитента, новости РБК/Интерфакс,
центр раскрытия) РСБУ-показатели за последние 3 года, особенно за ${expected} год
(публикуется по 31 марта ${expected + 1}).

ВЕРНИ ТОЛЬКО JSON по схеме (без markdown, без пояснений):
{
  "company": "точное название с ОПФ или null",
  "ogrn": "ОГРН (13-15 цифр) или null",
  "series": {
    "${expected}": {
      "rev": число (выручка, стр. 2110)         или null,
      "ebit": число (операц. прибыль, 2200)     или null,
      "np":  число (чистая прибыль, 2400)       или null,
      "int_exp": число (% к уплате, 2330)       или null,
      "tax_exp": число (налог, 2410)            или null,
      "assets": число (всего активов, 1600)     или null,
      "ca":   число (оборотные активы, 1200)    или null,
      "cl":   число (краткосроч. обяз., 1500)   или null,
      "debt": число (1410+1510 займы)           или null,
      "cash": число (ден. средства, 1250)       или null,
      "ret":  число (нераспред. прибыль, 1370)  или null,
      "eq":   число (собств. капитал, 1300)     или null
    },
    "${expected - 1}": { ... те же поля ... },
    "${expected - 2}": { ... те же поля ... }
  },
  "source_urls": ["https://...", "..."],
  "confidence": число от 0 до 1
}

ПРАВИЛА:
- ВСЕ суммы переводи в МЛРД ₽. В источнике в тыс ₽ → /1e6, в млн → /1000.
- Если поля нет в источнике — null. НЕ ВЫДУМЫВАЙ.
- Если по этому ИНН вообще нет данных в открытых источниках — верни
  {"series": {}, "errors": ["причина"]}.
- Только валидный JSON, никакого markdown.`;

  const res = await callAi(env, 'grok', prompt, {
    schema: 'report',
    inn,
    cacheKey: `report|${inn}|${expected}`,
    cacheTtlDays: 30,
    model: opts?.model || 'grok-4-fast-reasoning',
    search: 'on', // явно включаем Live Search — без него Grok не пойдёт в e-disclosure
    max_search_results: 6,
    max_tokens: 3500,
  });

  let parsed;
  try {
    let s = res.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    parsed = JSON.parse(s);
  } catch(e){
    throw new Error('grok: невалидный JSON');
  }
  if(!parsed.series || !Object.keys(parsed.series).length){
    throw new Error('grok: ничего не найдено' + (parsed.errors ? ': ' + parsed.errors.join(', ') : ''));
  }

  const series = {};
  const rawByYear = {};
  for(const [yearStr, vals] of Object.entries(parsed.series)){
    const y = parseInt(yearStr, 10);
    if(!y || !vals || typeof vals !== 'object') continue;
    series[y] = {};
    for(const k of ['rev','ebit','np','int_exp','tax_exp','assets','ca','cl','debt','cash','ret','eq']){
      if(typeof vals[k] === 'number' && isFinite(vals[k])) series[y][k] = vals[k];
    }
    rawByYear[y] = {
      _from_grok: true,
      source_urls: parsed.source_urls || [],
      confidence: parsed.confidence ?? null,
    };
  }
  return {
    series,
    rawByYear,
    company: parsed.company || name,
    inn,
    ogrn: parsed.ogrn || null,
    errors: [],
  };
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

// Сбор справочника эмитентов и обогащение bond_daily ИННами.
//
// Корень проблемы: per-board endpoint `/iss/engines/.../boards/{board}/securities.json`
// НЕ возвращает поля EMITENT_TITLE / EMITENT_INN — там только LATNAME
// (латиницей) и базовая статика выпуска. Без INN мы не можем ни группировать
// бумаги по эмитенту, ни сверять с reportsDB, ни искать в каталоге.
//
// Правильный источник — bulk `/iss/securities.json?engine=stock&market=bonds&iss.only=securities`.
// Он отдаёт по 100 строк на страницу с колонками emitent_id/emitent_title/
// emitent_inn/emitent_okpo. Активных бумаг ~6000, итого ~60 страниц = ~60
// subrequest'ов на запуск. Free tier CF Workers — 50 subrequest на cron,
// поэтому MAX_PAGES = 60 (в crone у Unbound лимит существенно выше; на
// free tier лишние страницы упадут, но первая партия пройдёт).
//
// Что делаем:
//   1. Идём страницами по bulk-endpoint, собираем секмапу secid → emitter.
//   2. Одной транзакцией обновляем bond_daily.{emitent_inn, emitent_name}
//      для последнего среза (date = MAX(date)). Старые срезы не трогаем —
//      история торговых данных не должна задним числом меняться.
//   3. Из этой же выборки собираем уникальных emitter_id и подтягиваем
//      OGRN/полный INN/legal address из /iss/emitters/{id}.json — но
//      только для top-N по числу выпусков (чтобы не сжечь subrequest'ы).
//   4. Upsert'им issuers с актуальными bonds_count.
//
// Запускается ежедневно cron'ом — без него каталог пустой.
async function collectIssuers(env, url){
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const base = env.MOEX_BASE || 'https://iss.moex.com';
  const now = new Date().toISOString();
  const today = new Date().toISOString().slice(0, 10);
  let rowsWritten = 0;
  const errors = [];

  const maxPages   = parseInt(url?.searchParams?.get('max_pages') || '60', 10);
  const cardLimit  = parseInt(url?.searchParams?.get('cards')     || '40', 10);

  // ── Шаг 1: bulk MOEX → secid → {emitter_id, name, inn} ─────────────
  // Карта по secid (для апдейта bond_daily) и отдельная по emitter_id
  // (для сбора уникальных эмитентов в issuers).
  const bySecid    = new Map();
  const byEmitter  = new Map();
  let pagesRead = 0, secidsSeen = 0;
  try {
    for(let page = 0; page < maxPages; page++){
      const u = `${base}/iss/securities.json?iss.meta=off&engine=stock&market=bonds&iss.only=securities&limit=100&start=${page * 100}`;
      const r = await fetch(u, { headers: { 'Accept': 'application/json' }, cf: { cacheTtl: 0 } });
      if(!r.ok){ errors.push(`bulk page ${page}: HTTP ${r.status}`); break; }
      const json = await r.json();
      const sec  = json.securities || {};
      const cols = sec.columns || [];
      const data = sec.data || [];
      if(!data.length) break;
      const i = (n) => cols.indexOf(n);
      const idxSecid = i('secid'), idxEid = i('emitent_id'),
            idxTitle = i('emitent_title'), idxInn = i('emitent_inn'),
            idxOkpo  = i('emitent_okpo'), idxIsin  = i('isin'),
            idxBoard = i('primary_boardid');
      for(const row of data){
        const secid = row[idxSecid]; if(!secid) continue;
        const eid   = row[idxEid];
        const title = row[idxTitle];
        const inn   = row[idxInn] != null ? String(row[idxInn]) : null;
        const okpo  = row[idxOkpo] != null ? String(row[idxOkpo]) : null;
        const board = row[idxBoard] || null;
        bySecid.set(secid, { eid, title, inn, board });
        if(eid != null && !byEmitter.has(eid)){
          byEmitter.set(eid, { eid, title, inn, okpo, bonds_count: 0 });
        }
        if(eid != null){ byEmitter.get(eid).bonds_count++; }
      }
      secidsSeen += data.length;
      pagesRead++;
      if(data.length < 100) break; // последняя страница
    }
  } catch(e){ errors.push('bulk fetch: ' + e.message); }

  // ── Шаг 2: апдейтим bond_daily.emitent_inn / emitent_name на сегодня ──
  // Только последний срез — старые даты не трогаем. Делаем батчем, без
  // INSERT — только UPDATE существующих строк (если бумага числится в
  // bond_daily, у неё точно есть строка за date=today).
  let bondsUpdated = 0;
  if(bySecid.size){
    try {
      const upd = `UPDATE bond_daily SET emitent_name = ?, emitent_inn = ? WHERE secid = ? AND date = ?`;
      const stmts = [];
      for(const [secid, e] of bySecid){
        if(!e.title && !e.inn) continue;
        stmts.push(env.DB.prepare(upd).bind(e.title || null, e.inn || null, secid, today));
      }
      // batch-ом по 200 — у D1 лимит ~1000 операторов на batch
      for(let i = 0; i < stmts.length; i += 200){
        const chunk = stmts.slice(i, i + 200);
        const res = await env.DB.batch(chunk);
        bondsUpdated += res.reduce((s, r) => s + (r.meta?.changes || r.meta?.rows_written || 0), 0);
      }
    } catch(e){ errors.push('bond_daily update: ' + e.message); }
  }

  // ── Шаг 3: подтянуть OGRN / полный INN / legal_address для top-N ───
  // /iss/emitters/{id}.json даёт TITLE, SHORT_TITLE, INN, OGRN, OKPO,
  // OKSM, LEGAL_ADDRESS, URL, EMITTER_CAPITALIZATION. На free tier
  // экономим subrequest'ы — берём top-N эмитентов по числу бумаг.
  const topEmitters = [...byEmitter.values()]
    .filter(e => e.eid != null)
    .sort((a, b) => b.bonds_count - a.bonds_count)
    .slice(0, cardLimit);
  for(const e of topEmitters){
    try {
      const u = `${base}/iss/emitters/${e.eid}.json?iss.meta=off`;
      const r = await fetch(u, { headers: { 'Accept': 'application/json' }, cf: { cacheTtl: 86400 } });
      if(!r.ok) continue;
      const j = await r.json();
      const cols = j?.emitter?.columns || [];
      const row  = j?.emitter?.data?.[0];
      if(!row) continue;
      const get = (n) => row[cols.indexOf(n)];
      e.title    = get('TITLE')         || e.title;
      e.short    = get('SHORT_TITLE')   || null;
      e.inn      = get('INN')           || e.inn;
      e.ogrn     = get('OGRN')          || null;
      e.okpo     = get('OKPO')          || e.okpo;
      e.address  = get('LEGAL_ADDRESS') || null;
      e.url      = get('URL')           || null;
      e.capRub   = get('EMITTER_CAPITALIZATION') || null;
    } catch(_){ /* игнорим единичные неудачи */ }
  }

  // ── Шаг 4: тикеры акций: маппинг shortname-prefix → ticker ─────────
  let stockMap = {};
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
      const key = normalizeIssuerName(row.name);
      if(key && !stockMap[key]) stockMap[key] = row.ticker;
    }
  } catch(e){ errors.push('stocks for ticker matching: ' + e.message); }

  // ── Шаг 5: upsert в issuers (не затираем ручные правки) ───────────
  // Поля name/short_name/bonds_count перезаписываем (актуализируем),
  // ticker/sector/okved/aliases — только если они null.
  const upsertSql = `
    INSERT INTO issuers (
      inn, ogrn, name, short_name, ticker, bonds_count, aliases, meta, source, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(inn) DO UPDATE SET
      ogrn        = COALESCE(excluded.ogrn, issuers.ogrn),
      name        = excluded.name,
      short_name  = excluded.short_name,
      bonds_count = excluded.bonds_count,
      ticker      = COALESCE(issuers.ticker, excluded.ticker),
      aliases     = COALESCE(issuers.aliases, excluded.aliases),
      meta        = COALESCE(excluded.meta, issuers.meta),
      source      = COALESCE(issuers.source, excluded.source),
      updated_at  = excluded.updated_at
  `;
  const stmts = [];
  for(const e of byEmitter.values()){
    if(!e.inn) continue; // без ИНН эмитент бесполезен — не пишем
    const fullName  = e.title || '';
    const shortName = e.short || shortenIssuerName(fullName);
    const matchKey  = normalizeIssuerName(shortName);
    const ticker    = stockMap[matchKey] || null;
    const meta      = (e.address || e.url || e.capRub != null)
      ? JSON.stringify({ address: e.address || null, url: e.url || null, cap_rub: e.capRub ?? null, moex_id: e.eid })
      : null;
    const aliases   = (fullName && shortName && fullName !== shortName)
      ? JSON.stringify([fullName, shortName])
      : null;
    stmts.push(env.DB.prepare(upsertSql).bind(
      e.inn, e.ogrn || null, fullName, shortName, ticker,
      e.bonds_count || 0, aliases, meta, 'moex', now
    ));
  }
  if(stmts.length){
    try {
      // Дробим на 200 — лимит D1 batch ~1000 stmts
      for(let i = 0; i < stmts.length; i += 200){
        const chunk = stmts.slice(i, i + 200);
        const results = await env.DB.batch(chunk);
        rowsWritten += results.reduce((s, r) => s + (r.meta?.rows_written || 0), 0);
      }
    } catch(e){ errors.push('issuers batch upsert: ' + e.message); }
  }

  // ── Шаг 6: пополняем reports_queue новыми ИНН ──────────────────────
  // Чтобы коллектор отчётности знал, кого ещё не пытался обработать.
  if(byEmitter.size){
    try {
      const qSql = `INSERT OR IGNORE INTO reports_queue (inn, next_due) VALUES (?, datetime('now'))`;
      const qStmts = [];
      for(const e of byEmitter.values()){
        if(e.inn) qStmts.push(env.DB.prepare(qSql).bind(e.inn));
      }
      for(let i = 0; i < qStmts.length; i += 200){
        await env.DB.batch(qStmts.slice(i, i + 200));
      }
    } catch(e){ errors.push('queue seed: ' + e.message); }
  }

  await logRun(env, startedAt, 'issuers', rowsWritten, errors, Date.now() - t0);
  return {
    source: 'issuers',
    rowsWritten,
    bondsUpdated,
    pagesRead,
    secidsSeen,
    issuersSeen: byEmitter.size,
    cardsFetched: topEmitters.length,
    errors,
    duration_ms: Date.now() - t0,
  };
}

// ═══ Коллектор: РСБУ-показатели из ГИР БО ════════════════════════════
//
// ГИР БО (bo.nalog.gov.ru) — официальный реестр бухотчётности ФНС.
// Из браузера он недоступен (нет CORS), но Worker — это серверный код,
// поэтому стучимся напрямую. На каждого эмитента: 1 поиск по ИНН +
// 1 список отчётов + 2 формы (balance + financial_result) на каждый
// год. Берём 3 свежих года → ~7 subrequest'ов на эмитента. На free
// tier лимит 50 subrequest'ов на cron-вызов, поэтому в одном проходе
// успеваем 6-7 эмитентов; ставим limit=20 при ручном вызове из админки
// (в paid plan лимита фактически нет).
//
// Очередь reports_queue решает «справедливое распределение»: на каждом
// запуске берём top-N эмитентов с самым старым last_attempt
// (или null). После успеха next_due ставим +30 дней.
//
// Маппинг кодов ГИР БО → короткие метрики БондАналитика — тот же,
// что в app.js (_GIRBO_FIELD_MAP). Все суммы из ФНС в тыс ₽,
// делим на 1e6 → млрд ₽ (внутренняя единица).

// Маппинг короткие имена → коды строк РСБУ. 2330 — расходы (берём
// модуль), debt = 1410 (долгосрочные займы) + 1510 (краткосрочные).
const GIRBO_CODES = {
  rev:     ['2110'],
  ebit:    ['2200'],
  np:      ['2400'],
  int_exp: ['2330'],
  tax_exp: ['2410'],
  assets:  ['1600'],
  ca:      ['1200'],
  cl:      ['1500'],
  debt:    ['1410', '1510'],
  cash:    ['1250'],
  ret:     ['1370'],
  eq:      ['1300'],
};

// Один fetch с timeout и единым retry-протоколом для ГИР БО.
async function girboFetch(path, opts){
  const url  = 'https://bo.nalog.gov.ru' + path;
  const tout = opts?.timeoutMs || 12000;
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), tout);
  try {
    const r = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'BondAnalytics/0.6 (+github.com/mortyc126-debug/ti)' },
      signal: ctrl.signal,
    });
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const ct = r.headers.get('content-type') || '';
    if(!/json/i.test(ct)){
      const txt = await r.text();
      if(txt.startsWith('<')) throw new Error('ГИР БО вернул HTML (капча или блок)');
    }
    return await r.json();
  } finally { clearTimeout(tm); }
}

// Один эмитент: ИНН → series {год: {rev, ebit, np, ...}}.
// Возвращает {series, company, ogrn, errors}. Бросает Error если
// ГИР БО вообще ничего не нашёл по ИНН.
async function girboFetchByInn(inn, maxYears = 3){
  // 1. Поиск организации по ИНН
  let orgs = [];
  for(const path of [
    `/advanced-search/organizations/search?inn=${inn}`,
    `/nbo/organizations/?inn=${inn}`,
  ]){
    try {
      const r = await girboFetch(path);
      const got = Array.isArray(r) ? r : (r?.content || r?.organizations || []);
      if(got.length){ orgs = got; break; }
    } catch(_){ /* пробуем следующий */ }
  }
  if(!orgs.length) throw new Error('ГИР БО: ИНН ' + inn + ' не найден');
  const org = orgs.find(o => String(o.inn || o.organisationInn) === inn) || orgs[0];
  const orgId = org.id || org.organizationId;
  if(!orgId) throw new Error('ГИР БО: нет orgId в ответе');

  // 2. Список годовых отчётов
  const bfoListResp = await girboFetch(`/nbo/organizations/${orgId}/bfo/`);
  const bfoList = Array.isArray(bfoListResp)
    ? bfoListResp
    : (bfoListResp.content || bfoListResp.bfo || []);
  const isAnnual = (b) => {
    if(/^\d{4}$/.test(String(b.period || ''))) return true;
    if(/year|год/i.test(b.period || b.bfoPeriod || '')) return true;
    if(b.periodType === 'YEAR' || b.periodType === 12) return true;
    if(Array.isArray(b.bfoPeriodTypes) && b.bfoPeriodTypes.includes(12)) return true;
    return false;
  };
  const yearOf = (b) => parseInt(b.period || b.year || '0', 10) || 0;
  const annual = bfoList
    .filter(isAnnual)
    .sort((a, b) => yearOf(b) - yearOf(a))
    .slice(0, maxYears);
  if(!annual.length) throw new Error('ГИР БО: нет годовых отчётов');

  // 3. Детали каждого отчёта: balance + financial_result
  const series = {};
  const rawByYear = {};
  const errors = [];
  for(const b of annual){
    try {
      const corr = b?.typeCorrections?.[0]?.correction
                || b?.corrections?.[0]?.correction
                || b?.correction
                || null;
      const corrId = corr?.id || b.id || b.bfoId;
      let det;
      if(corr && (corr.balance || corr.financialResult) &&
         (corr.balance?.current1600 != null || corr.financialResult?.current2110 != null)){
        det = Object.assign({}, corr.balance || {}, corr.financialResult || {});
      } else {
        const [balance, pnl] = await Promise.all([
          girboFetch('/nbo/details/balance?id=' + corrId).catch(() => ({})),
          girboFetch('/nbo/details/financial_result?id=' + corrId).catch(() => ({})),
        ]);
        det = Object.assign({}, balance, pnl);
      }
      const yearMain = b.year || (b.period ? parseInt(b.period, 10) : null) || det.year;
      const yearPrev = yearMain ? yearMain - 1 : null;
      // build* — формирует {rev, ebit, ...} из current<code>/previous<code>.
      // ГИР БО даёт «текущий» и «прошлый» годы внутри одного отчёта,
      // поэтому 1 годовой отчёт = 2 года данных бесплатно.
      const buildVals = (kind) => {
        const v = {};
        for(const [field, codes] of Object.entries(GIRBO_CODES)){
          let sum = 0, any = false;
          for(const c of codes){
            const x = det[kind + c];
            if(typeof x === 'number'){ sum += x; any = true; }
          }
          if(any){
            const isExpense = field === 'int_exp' || field === 'tax_exp';
            v[field] = (isExpense ? Math.abs(sum) : sum) / 1e6; // тыс ₽ → млрд ₽
          }
        }
        return Object.keys(v).length ? v : null;
      };
      const cur = buildVals('current');
      if(cur && yearMain && !series[yearMain]){
        series[yearMain] = cur;
        rawByYear[yearMain] = pickRaw(det, 'current');
      }
      const prev = buildVals('previous');
      if(prev && yearPrev && !series[yearPrev]){
        series[yearPrev] = prev;
        rawByYear[yearPrev] = pickRaw(det, 'previous');
      }
    } catch(e){
      errors.push({ year: yearOf(b), error: e.message });
    }
  }
  return {
    series,
    rawByYear,
    company: org.name || org.shortName || org.fullName || null,
    inn,
    ogrn: org.ogrn || org.organisationOgrn || null,
    errors,
  };
}

// Выкусываем из json все интересующие нас current<code>/previous<code> —
// сохраняем в issuer_reports.raw как маленький JSON, чтобы при
// необходимости пересчитать без повторного похода в ФНС.
function pickRaw(det, kind){
  const out = {};
  for(const codes of Object.values(GIRBO_CODES)){
    for(const c of codes){
      const x = det[kind + c];
      if(typeof x === 'number') out[c] = x;
    }
  }
  return out;
}

// ═══ Альтернативный источник: buxbalans.ru ════════════════════════════
//
// buxbalans.ru — публичный агрегатор бухотчётности, пускает без капчи.
// На странице `/{INN}.html` для каждого кода РСБУ (1300, 1600, 2110,
// 2400 и т.д.) встроен chart-блок:
//   var myChart_chart_{INN}_{CODE} = new Chart(...)
//   data: { labels: [2011,2012,...,2024],
//           datasets: [{ data: [v1, v2, ..., vN], ... }] }
// Регексом цепляем первое `labels:[…]` после метки и первое `data:[…]`
// после labels — это и есть ряд значений конкретного кода (нижестоящие
// data: — сравнения/тренды, нам не нужны). Все суммы, как и в ГИР БО,
// в тыс ₽ (страница так и подписывает) → делим на 1e6 → млрд ₽.
//
// Зачем нужен: у buxbalans глубже история (с 2011, ГИР БО держит ~5 лет)
// и шире покрытие — там появляются ИНН ВДО, которые ФНС не успевает
// или не хочет публиковать через свой /nbo. Кеш на стороне Cloudflare
// даёт стабильность.
//
// Ограничения: только РСБУ (МСФО на buxbalans нет), значения «как у
// ФНС опубликовано», без агрегации по группе компаний.
async function buxBalansFetchByInn(inn, opts){
  const tout = opts?.timeoutMs || 15000;
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), tout);
  let html;
  try {
    const r = await fetch(`https://buxbalans.ru/${inn}.html`, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; BondAnalytics/0.7; +github.com/mortyc126-debug/ti)',
      },
      signal: ctrl.signal,
    });
    if(r.status === 404) throw new Error('buxbalans: ИНН ' + inn + ' не найден');
    if(!r.ok) throw new Error('buxbalans HTTP ' + r.status);
    html = await r.text();
  } finally { clearTimeout(tm); }
  if(!html || html.length < 2000) throw new Error('buxbalans: пустой ответ (' + (html?.length || 0) + ')');

  // Имя компании — обычно в <h1> заголовке.
  let company = null;
  const mH1 = html.match(/<h1[^>]*>([^<]{3,200})<\/h1>/);
  if(mH1) company = mH1[1].replace(/\s+/g, ' ').trim();

  const series = {};
  const rawByYear = {};
  // Сначала — какие коды нас интересуют. Расходы (interest, tax) —
  // отдельным флагом, чтобы в ряд клались по модулю.
  const want = [
    { code: '2110', field: 'rev'     },
    { code: '2200', field: 'ebit'    },
    { code: '2400', field: 'np'      },
    { code: '2330', field: 'int_exp', expense: true },
    { code: '2410', field: 'tax_exp', expense: true },
    { code: '1600', field: 'assets'  },
    { code: '1200', field: 'ca'      },
    { code: '1500', field: 'cl'      },
    { code: '1410', field: 'debt_long'  },
    { code: '1510', field: 'debt_short' },
    { code: '1250', field: 'cash'    },
    { code: '1370', field: 'ret'     },
    { code: '1300', field: 'eq'      },
  ];
  for(const w of want){
    // Привязываемся к метке myChart_chart_{inn}_{code}, ищем дальше
    // первый блок `labels: [...]` и затем первый `data: [...]`. Между
    // меткой и labels всегда коротко (объект options/responsive).
    const re = new RegExp(
      `myChart_chart_${inn}_${w.code}\\b[\\s\\S]{0,4000}?labels\\s*:\\s*\\[([^\\]]+)\\][\\s\\S]{0,1500}?data\\s*:\\s*\\[([^\\]]+)\\]`
    );
    const m = html.match(re);
    if(!m) continue;
    const years = m[1].split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
    const vals  = m[2].split(',').map(s => {
      const t = s.trim().replace(/[^0-9.\-]/g, '');
      return t ? parseFloat(t) : NaN;
    });
    for(let i = 0; i < years.length && i < vals.length; i++){
      const y = years[i];
      const v = vals[i];
      if(!isFinite(v) || !y) continue;
      series[y]    = series[y]    || {};
      rawByYear[y] = rawByYear[y] || {};
      rawByYear[y][w.code] = v;
      const out = (w.expense ? Math.abs(v) : v) / 1e6; // тыс ₽ → млрд ₽
      if(w.field === 'debt_long' || w.field === 'debt_short'){
        series[y].debt = (series[y].debt || 0) + out;
      } else {
        series[y][w.field] = out;
      }
    }
  }
  if(!Object.keys(series).length) throw new Error('buxbalans: ни одного chart-блока не разобрано');
  return { series, rawByYear, company, inn, ogrn: null, errors: [] };
}

// ═══ Каскад источников и логика «свежести» ═══════════════════════════
//
// Ожидаемый последний публикованный год РСБУ. Дедлайн годовой
// отчётности — 31 марта следующего года. Поэтому:
//   с 1 апреля     → ожидаем тек.год − 1 (свежий годовик уже сдан)
//   до 31 марта    → ожидаем тек.год − 2 (за прошлый год ещё могут
//                    не успеть, не считаем «устаревшими»).
function expectedFyYear(d){
  const x = d || new Date();
  return x.getUTCMonth() >= 3 ? x.getUTCFullYear() - 1 : x.getUTCFullYear() - 2;
}

// Источники в порядке приоритета. Каждый источник возвращает один и
// тот же контракт {series, rawByYear, company, inn, ogrn, errors}.
const REPORT_SOURCES = [
  { name: 'girbo',     fn: girboFetchByInn      },
  { name: 'buxbalans', fn: buxBalansFetchByInn  },
];

// Главный коллектор отчётности. Поддерживает каскад источников и
// перепроверку, если последний имеющийся год < ожидаемого.
//
// Параметры (query string):
//   ?limit=N            — взять top-N из очереди (default 20, max 50)
//   ?inn=X              — обработать конкретный ИНН (тогда limit игнорируется)
//   ?force=1            — игнорировать «уже свежие», прогнать заново
//   ?only_traded=1      — только эмитенты с активными бумагами в bond_daily
async function collectReports(env, url){
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const now = new Date().toISOString();
  const limit = Math.min(50, parseInt(url?.searchParams?.get('limit') || '20', 10));
  const onlyInn = url?.searchParams?.get('inn');
  const force   = url?.searchParams?.get('force') === '1';
  const onlyTraded = url?.searchParams?.get('only_traded') === '1';
  // include_ai=1 — разрешает Grok как третий fallback. Default off, чтобы
  // случайный запуск не сжёг квоту xAI. ai_budget — максимум вызовов
  // Grok за этот прогон (помимо кеш-хитов).
  const includeAi = url?.searchParams?.get('include_ai') === '1';
  const aiBudget  = Math.min(20, parseInt(url?.searchParams?.get('ai_budget') || '5', 10));
  const today = new Date().toISOString().slice(0, 10);
  const expected = expectedFyYear(new Date());
  const errors = [];
  let processed = 0, succeeded = 0, rowsWritten = 0, aiUsed = 0;
  const sourceStats = { girbo: 0, buxbalans: 0, grok: 0, none: 0 };

  // ── Формирование очереди ──────────────────────────────────────────
  // Приоритет:
  //   1. ИНН с активными бумагами (bond_daily.status='A' AND mat_date >= today)
  //   2. Те, у кого нет свежего года (или нет вообще ничего)
  //   3. Самые старые next_due
  // SQL-подзапрос is_traded считает, есть ли у ИНН живая бумага сейчас;
  // max_year — самый свежий год в issuer_reports (NULL если никогда не было).
  let queue = [];
  if(onlyInn){
    queue = [{ inn: onlyInn, max_year: null, is_traded: 1 }];
  } else {
    const tradedFilter = onlyTraded ? 'AND COALESCE(t.is_traded, 0) = 1' : '';
    const sql = `
      SELECT q.inn,
             COALESCE(t.is_traded, 0) AS is_traded,
             rmax.max_year             AS max_year,
             q.attempts                AS attempts
      FROM reports_queue q
      LEFT JOIN (
        SELECT emitent_inn AS inn, 1 AS is_traded
        FROM bond_daily
        WHERE date = (SELECT MAX(date) FROM bond_daily)
          AND emitent_inn IS NOT NULL AND emitent_inn != ''
          AND (status IS NULL OR status = 'A')
          AND (mat_date IS NULL OR mat_date >= ?)
        GROUP BY emitent_inn
      ) t ON t.inn = q.inn
      LEFT JOIN (
        SELECT inn, MAX(fy_year) AS max_year FROM issuer_reports GROUP BY inn
      ) rmax ON rmax.inn = q.inn
      WHERE (q.next_due IS NULL OR q.next_due <= datetime('now'))
        ${tradedFilter}
        AND (
          ? = 1                              -- force: берём всех
          OR rmax.max_year IS NULL           -- никогда не пробовали
          OR rmax.max_year < ?               -- последний год < ожидаемого
        )
      ORDER BY
        COALESCE(t.is_traded, 0) DESC,       -- сначала торгуемые
        COALESCE(rmax.max_year, 0) ASC,      -- потом самые «отставшие»
        q.attempts ASC,
        COALESCE(q.last_attempt, '0') ASC
      LIMIT ?
    `;
    try {
      const r = await env.DB.prepare(sql)
        .bind(today, force ? 1 : 0, expected, limit).all();
      queue = r.results || [];
    } catch(e){ errors.push('queue: ' + e.message); }
  }

  if(!queue.length){
    await logRun(env, startedAt, 'reports', 0, ['queue empty / nothing stale'], Date.now() - t0);
    return {
      source: 'reports',
      expected_year: expected,
      processed: 0,
      succeeded: 0,
      rowsWritten: 0,
      sourceStats,
      errors: ['queue empty / nothing stale'],
      duration_ms: Date.now() - t0,
    };
  }

  // ── Подготовка prepared SQL ───────────────────────────────────────
  // PK issuer_reports — (inn, fy_year, period, std). source — обычное
  // поле, при пересчёте источником с более высоким приоритетом
  // переписываем (DO UPDATE).
  const upsertReport = `
    INSERT INTO issuer_reports (
      inn, fy_year, period, std,
      rev, ebitda, ebit, np, int_exp, tax_exp,
      assets, ca, cl, debt, cash, ret, eq,
      roa_pct, ros_pct, ebitda_marg, net_debt_eq,
      source, raw, fetched_at
    ) VALUES (?, ?, 'FY', 'РСБУ',
              ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?)
    ON CONFLICT(inn, fy_year, period, std) DO UPDATE SET
      rev = excluded.rev, ebitda = excluded.ebitda, ebit = excluded.ebit,
      np = excluded.np, int_exp = excluded.int_exp, tax_exp = excluded.tax_exp,
      assets = excluded.assets, ca = excluded.ca, cl = excluded.cl,
      debt = excluded.debt, cash = excluded.cash, ret = excluded.ret, eq = excluded.eq,
      roa_pct = excluded.roa_pct, ros_pct = excluded.ros_pct,
      ebitda_marg = excluded.ebitda_marg, net_debt_eq = excluded.net_debt_eq,
      source = excluded.source, raw = excluded.raw, fetched_at = excluded.fetched_at
  `;
  // Очередь: динамический cooldown в зависимости от результата.
  //   fresh   = +30 дней (ожидаемый год получен)
  //   partial = +7  дней (что-то получено, но не ожидаемый)
  //   miss    = +14 дней (ничего не вышло)
  const updateQueue = `
    INSERT INTO reports_queue (inn, last_attempt, last_success, attempts, last_error, next_due)
    VALUES (?, ?, ?, ?, ?, datetime(?, ?))
    ON CONFLICT(inn) DO UPDATE SET
      last_attempt = excluded.last_attempt,
      last_success = COALESCE(excluded.last_success, reports_queue.last_success),
      attempts     = CASE WHEN excluded.last_success IS NOT NULL
                          THEN 0
                          ELSE reports_queue.attempts + 1 END,
      last_error   = excluded.last_error,
      next_due     = excluded.next_due
  `;

  // ── Обработка ИНН: каскад источников ──────────────────────────────
  for(const item of queue){
    const inn = item.inn;
    if(!inn) continue;
    processed++;
    let usedSource = null;
    let lastErr = null;
    let maxYearGot = 0;
    let totalRows = 0;
    const sourceErrors = [];

    // Внутренняя функция: применить результат от любого источника —
    // upsert строк в issuer_reports + апдейт имени/ОГРН в issuers.
    // Возвращает кол-во записанных лет и обновляет maxYearGot/usedSource
    // через замыкание.
    const applyFetched = async (srcName, fetched) => {
      if(!fetched?.series || !Object.keys(fetched.series).length) return 0;
      const yearStmts = [];
      for(const [yearStr, vals] of Object.entries(fetched.series)){
        const fy = parseInt(yearStr, 10);
        if(!fy) continue;
        if(fy > maxYearGot) maxYearGot = fy;
        const rev = vals.rev ?? null;
        const np  = vals.np  ?? null;
        const eq  = vals.eq  ?? null;
        const debt = vals.debt ?? null;
        const cash = vals.cash ?? null;
        const assets = vals.assets ?? null;
        const ebitda = (vals.ebit != null && vals.int_exp != null)
          ? (vals.ebit + vals.int_exp) : null;
        const roa  = (np != null && assets) ? np / assets * 100 : null;
        const ros  = (np != null && rev)    ? np / rev * 100    : null;
        const em   = (ebitda != null && rev) ? ebitda / rev * 100 : null;
        const nde  = (debt != null && cash != null && eq) ? (debt - cash) / eq : null;
        const raw  = JSON.stringify(fetched.rawByYear?.[fy] || {});
        yearStmts.push(env.DB.prepare(upsertReport).bind(
          inn, fy,
          rev, ebitda, vals.ebit ?? null, np, vals.int_exp ?? null, vals.tax_exp ?? null,
          assets, vals.ca ?? null, vals.cl ?? null, debt, cash, vals.ret ?? null, eq,
          roa, ros, em, nde,
          srcName, raw, now,
        ));
      }
      let rows = 0;
      if(yearStmts.length){
        for(let i = 0; i < yearStmts.length; i += 200){
          const chunk = yearStmts.slice(i, i + 200);
          const res = await env.DB.batch(chunk);
          rows += res.reduce((s, r) => s + (r.meta?.rows_written || 0), 0);
        }
      }
      if(fetched.company || fetched.ogrn){
        try {
          await env.DB.prepare(`
            UPDATE issuers
               SET name  = COALESCE(?, name),
                   ogrn  = COALESCE(issuers.ogrn, ?),
                   updated_at = ?
             WHERE inn = ?
          `).bind(fetched.company || null, fetched.ogrn || null, now, inn).run();
        } catch(_){}
      }
      usedSource = srcName;
      return rows;
    };

    // ── Слой 1+2: ГИР БО, buxbalans ─────────────────────────────────
    for(const src of REPORT_SOURCES){
      try {
        const fetched = await src.fn(inn, 5);
        if(!fetched.series || !Object.keys(fetched.series).length){
          throw new Error(src.name + ': пустой series');
        }
        totalRows += await applyFetched(src.name, fetched);
        // Если получили ожидаемый год — каскад дальше не идём.
        if(maxYearGot >= expected) break;
      } catch(e){
        const msg = (e.message || String(e)).slice(0, 200);
        sourceErrors.push(`${src.name}: ${msg}`);
        lastErr = msg;
      }
    }

    // ── Слой 3: Grok-fallback ────────────────────────────────────────
    // Запускаем только если:
    //   • include_ai=1 в query (явный opt-in)
    //   • есть xAI ключ в Worker secrets
    //   • эмитент с торгуемыми бумагами (для рандомных левых ИНН смысла
    //     палить квоту нет)
    //   • первые два источника не дали ожидаемый год
    //   • бюджет ai_budget на текущий прогон не исчерпан
    if(includeAi && env.XAI_API_KEY && item.is_traded
        && maxYearGot < expected && aiUsed < aiBudget){
      try {
        const fetched = await xaiFetchByInn(inn, { env });
        if(fetched.series && Object.keys(fetched.series).length){
          totalRows += await applyFetched('grok', fetched);
        }
        aiUsed++;
      } catch(e){
        const msg = (e.message || String(e)).slice(0, 200);
        sourceErrors.push(`grok: ${msg}`);
        lastErr = msg;
      }
    }

    rowsWritten += totalRows;
    if(usedSource){
      sourceStats[usedSource] = (sourceStats[usedSource] || 0) + 1;
      succeeded++;
      // Cooldown: получили ожидаемый год → +30, иначе +7 (вернёмся скоро,
      // вдруг ФНС/buxbalans скоро дотянут).
      const isFresh = maxYearGot >= expected;
      const offset  = isFresh ? '+30 days' : '+7 days';
      const errStr  = sourceErrors.length ? sourceErrors.join(' | ').slice(0, 200) : null;
      try {
        await env.DB.prepare(updateQueue)
          .bind(inn, now, now, 0, errStr, now, offset).run();
      } catch(_){}
    } else {
      sourceStats.none++;
      // Ни один источник не дал ничего. Если у эмитента есть торгуемые
      // бумаги — всё равно держим в очереди (next_due = +14 дней),
      // иначе тоже +14, но с увеличенным attempts.
      const offset = item.is_traded ? '+14 days' : '+14 days';
      const errMsg = (sourceErrors.join(' | ') || 'no sources').slice(0, 200);
      errors.push({ inn, error: errMsg });
      try {
        await env.DB.prepare(updateQueue)
          .bind(inn, now, null, item.attempts || 0, errMsg, now, offset).run();
      } catch(_){}
    }
  }

  await logRun(
    env, startedAt, 'reports', rowsWritten,
    errors.map(e => e.inn ? `${e.inn}: ${e.error}` : e),
    Date.now() - t0
  );
  return {
    source: 'reports',
    expected_year: expected,
    processed,
    succeeded,
    rowsWritten,
    aiUsed,
    aiBudget: includeAi ? aiBudget : 0,
    sourceStats,
    errors: errors.slice(0, 20),
    duration_ms: Date.now() - t0,
  };
}

// ═══ Endpoints: отчётность эмитентов ══════════════════════════════════

async function handleIssuerReports(env, url){
  // /issuer/{inn}/reports → series по годам со всеми метриками
  const m = url.pathname.match(/^\/issuer\/(\d{10,12})\/reports$/);
  if(!m) return errResp('inn required, /issuer/{inn}/reports', 400);
  const inn = m[1];
  let rows = [];
  try {
    const r = await env.DB.prepare(`
      SELECT fy_year, period, std, rev, ebitda, ebit, np, int_exp, tax_exp,
             assets, ca, cl, debt, cash, ret, eq,
             roa_pct, ros_pct, ebitda_marg, net_debt_eq,
             source, fetched_at
      FROM issuer_reports
      WHERE inn = ?
      ORDER BY fy_year DESC, period
    `).bind(inn).all();
    rows = r.results || [];
  } catch(_){}
  return jsonResp({ inn, count: rows.length, data: rows });
}

async function handleReportsLatest(env, url){
  // /reports/latest?limit=N — самые свежие отчёты у эмитентов (для
  // витрины «обновили данные за неделю»).
  const limit = Math.min(500, parseInt(url.searchParams.get('limit') || '50', 10));
  const r = await env.DB.prepare(`
    SELECT r.inn, r.fy_year, r.period, r.std, r.rev, r.ebitda, r.np,
           r.assets, r.debt, r.eq, r.roa_pct, r.ros_pct, r.ebitda_marg,
           r.fetched_at,
           i.short_name AS issuer_name, i.ticker, i.bonds_count
    FROM issuer_reports r
    LEFT JOIN issuers i ON i.inn = r.inn
    ORDER BY r.fetched_at DESC
    LIMIT ?
  `).bind(limit).all();
  return jsonResp({ count: r.results?.length || 0, data: r.results || [] });
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
