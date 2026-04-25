// Cloudflare Worker — бэкенд БондАналитика.
//
// Сбор: акции (TQBR) + фьючерсы (FORTS) + облигации (TQCB корпораты,
// TQOB ОФЗ). На этом стенде строится basis для акций и spread-to-OFZ
// для бондов.
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

      if(req.method === 'POST' && (url.pathname === '/collect/stock' || url.pathname === '/collect/futures' || url.pathname === '/collect/bonds')){
        const token = req.headers.get('X-Admin-Token') || '';
        if(!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return errResp('unauthorized', 401);
        if(url.pathname === '/collect/stock')   return jsonResp(await collectStocks(env));
        if(url.pathname === '/collect/futures') return jsonResp(await collectFutures(env));
        if(url.pathname === '/collect/bonds')   return jsonResp(await collectBonds(env));
      }

      return errResp(
        'Not Found. Endpoints: /status, /stock/latest, /stock/history?secid=X, '
        + '/futures/latest?asset=X, /basis?asset=X, /basis/history?asset=X, '
        + '/bond/latest?board=TQCB, /bond/history?secid=X, /bond/issuer?inn=X, '
        + 'POST /collect/{stock|futures|bonds}',
        404
      );
    } catch(e){
      return errResp('internal: ' + (e.message || String(e)), 500);
    }
  },

  // Cron — ежедневный сбор всех досок.
  async scheduled(event, env, ctx){
    ctx.waitUntil((async () => {
      try { await collectStocks(env); }  catch(e){ console.error('cron stocks:',  e.message); }
      try { await collectFutures(env); } catch(e){ console.error('cron futures:', e.message); }
      try { await collectBonds(env); }   catch(e){ console.error('cron bonds:',   e.message); }
    })());
  },
};

// ═══ Endpoints ════════════════════════════════════════════════════════════

async function handleStatus(env){
  // bond_daily может ещё не существовать при первом деплое v0.3 —
  // оборачиваем в try-catch, чтобы /status оставался живым.
  let bondCount = null, bondLatest = null, bondTqcb = null, bondTqob = null;
  try {
    const [rb, lb, tqcb, tqob] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as c FROM bond_daily').first(),
      env.DB.prepare('SELECT MAX(date) as d FROM bond_daily').first(),
      env.DB.prepare("SELECT COUNT(DISTINCT secid) as c FROM bond_daily WHERE board = 'TQCB'").first(),
      env.DB.prepare("SELECT COUNT(DISTINCT secid) as c FROM bond_daily WHERE board = 'TQOB'").first(),
    ]);
    bondCount = rb?.c ?? 0;
    bondLatest = lb?.d ?? null;
    bondTqcb = tqcb?.c ?? 0;
    bondTqob = tqob?.c ?? 0;
  } catch(_){ /* таблицы ещё нет — миграция не запускалась */ }

  const [rowsStock, rowsFut, lastLog, latestStockDate, latestFutDate] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as c FROM stock_daily').first(),
    env.DB.prepare('SELECT COUNT(*) as c FROM futures_daily').first(),
    env.DB.prepare('SELECT * FROM collection_log ORDER BY started_at DESC LIMIT 5').all(),
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
      bond_daily_rows: bondCount,
      bond_latest_date: bondLatest,
      bond_unique_tqcb: bondTqcb,
      bond_unique_tqob: bondTqob,
    },
    recent_runs: lastLog.results || [],
    version: '0.3-pilot-bonds',
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

  for(const board of ['TQCB', 'TQOB']){
    let start = 0;
    let pages = 0;
    const PAGE = 500;
    const MAX_PAGES = 8; // защита от бесконечной пагинации, ~4000 бумаг хватит
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
