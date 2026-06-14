// Yandex Cloud Function — резервная копия cf-worker.js (OI·INTEL)
// Тот же набор маршрутов /db/*, /iss/*, /tinkoff*, но:
//  - вместо Cloudflare D1 — Yandex Database (YDB), serverless
//  - вместо Cloudflare fetch — обычный глобальный fetch (Node 18 runtime)
//
// Переменные окружения функции:
//   YDB_ENDPOINT  — напр. grpcs://ydb.serverless.yandexcloud.net:2135
//   YDB_DATABASE  — напр. /ru-central1/b1g.../etn...
// Сервисный аккаунт функции должен иметь роль ydb.editor на базу.

const { Driver, getCredentialsFromEnv, TypedValues, Types } = require('ydb-sdk');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Private-Network': 'true',
};

let driverPromise = null;
function getDriver() {
  if (!driverPromise) {
    const driver = new Driver({
      endpoint: process.env.YDB_ENDPOINT,
      database: process.env.YDB_DATABASE,
      authService: getCredentialsFromEnv(),
    });
    driverPromise = driver.ready(10000).then(ok => {
      if (!ok) throw new Error('YDB driver not ready');
      return driver;
    });
  }
  return driverPromise;
}

async function withSession(fn) {
  const driver = await getDriver();
  return driver.tableClient.withSession(fn);
}

function resp(status, bodyObj, extraHeaders) {
  return {
    statusCode: status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    body: JSON.stringify(bodyObj),
  };
}

// ── Schema ───────────────────────────────────────────────────────────────
const SCHEMA_STMTS = [
  `CREATE TABLE IF NOT EXISTS candles (
    key Utf8, ticker Utf8, tf Utf8, time Int64,
    o Double, h Double, l Double, cl Double, vol Int64,
    PRIMARY KEY(key)
  )`,
  `CREATE TABLE IF NOT EXISTS signals (
    id Serial, ts Utf8, ticker Utf8, tf Utf8,
    entry_price Double, entry_ts Int64, composite Double, dir Utf8,
    methods Utf8, mfe Double, mae Double, quality Double,
    resolved Int64, resolved_at Int64,
    PRIMARY KEY(id)
  )`,
  `CREATE TABLE IF NOT EXISTS weights (
    key Utf8, ticker Utf8, method_id Utf8,
    weight Double, total Int64, sum_quality Double, updated_at Int64,
    PRIMARY KEY(key)
  )`,
  `CREATE TABLE IF NOT EXISTS algopack (
    key Utf8, ticker Utf8, type Utf8, ts Int64,
    tradedate Utf8, tradetime Utf8, vals Utf8,
    PRIMARY KEY(key)
  )`,
  `CREATE TABLE IF NOT EXISTS percentiles (
    key Utf8, ticker Utf8, type Utf8, field Utf8, window_days Int64,
    p10 Double, p25 Double, p50 Double, p75 Double, p90 Double,
    n Int64, updated_at Int64,
    PRIMARY KEY(key)
  )`,
  `CREATE TABLE IF NOT EXISTS atr (
    key Utf8, ticker Utf8, tf Utf8, atr Double, atr_pct Double, n Int64, updated_at Int64,
    PRIMARY KEY(key)
  )`,
  `CREATE TABLE IF NOT EXISTS ind_verdicts (
    ticker Utf8, payload Utf8, updated_at Int64,
    PRIMARY KEY(ticker)
  )`,
];

async function dbInit() {
  await withSession(async session => {
    for (const stmt of SCHEMA_STMTS) {
      await session.executeQuery(stmt);
    }
  });
  return { ok: true, msg: 'schema ready (YDB backup)' };
}

// ── DB routes ────────────────────────────────────────────────────────────
async function handleDb(p, method, qs, body) {
  if (p === '/init') return resp(200, await dbInit());

  // ── Candles ──
  if (p === '/candles' && method === 'POST') {
    const rows = Array.isArray(body) ? body : [];
    if (!rows.length) return resp(200, { ok: true, inserted: 0 });
    await withSession(async session => {
      for (const r of rows) {
        await session.executeQuery(
          `DECLARE $key AS Utf8; DECLARE $ticker AS Utf8; DECLARE $tf AS Utf8; DECLARE $time AS Int64;
           DECLARE $o AS Double; DECLARE $h AS Double; DECLARE $l AS Double; DECLARE $cl AS Double; DECLARE $vol AS Int64;
           UPSERT INTO candles(key,ticker,tf,time,o,h,l,cl,vol) VALUES($key,$ticker,$tf,$time,$o,$h,$l,$cl,$vol)`,
          {
            '$key': TypedValues.utf8(r.key), '$ticker': TypedValues.utf8(r.ticker), '$tf': TypedValues.utf8(r.tf),
            '$time': TypedValues.int64(r.time),
            '$o': TypedValues.double(r.o || 0), '$h': TypedValues.double(r.h || 0),
            '$l': TypedValues.double(r.l || 0), '$cl': TypedValues.double(r.cl || 0),
            '$vol': TypedValues.int64(r.vol || 0),
          }
        );
      }
    });
    return resp(200, { ok: true, inserted: rows.length });
  }

  if (p === '/candles' && method === 'GET') {
    const { ticker, tf, from = '0' } = qs;
    if (!ticker || !tf) return resp(400, { error: 'ticker and tf required' });
    const rows = await withSession(async session => {
      const { resultSets } = await session.executeQuery(
        `DECLARE $ticker AS Utf8; DECLARE $tf AS Utf8; DECLARE $from AS Int64;
         SELECT * FROM candles WHERE ticker=$ticker AND tf=$tf AND time>=$from ORDER BY time ASC LIMIT 2000`,
        { '$ticker': TypedValues.utf8(ticker), '$tf': TypedValues.utf8(tf), '$from': TypedValues.int64(parseInt(from) || 0) }
      );
      return resultSets[0].rows || [];
    });
    return resp(200, rows.map(rowToObj));
  }

  // ── Signals ──
  if (p === '/signal' && method === 'POST') {
    const s = body || {};
    const id = await withSession(async session => {
      await session.executeQuery(
        `DECLARE $ts AS Utf8; DECLARE $ticker AS Utf8; DECLARE $tf AS Utf8; DECLARE $entry_price AS Double;
         DECLARE $entry_ts AS Int64; DECLARE $composite AS Double; DECLARE $dir AS Utf8; DECLARE $methods AS Utf8;
         INSERT INTO signals(ts,ticker,tf,entry_price,entry_ts,composite,dir,methods,mfe,mae,resolved)
         VALUES($ts,$ticker,$tf,$entry_price,$entry_ts,$composite,$dir,$methods,0.0,0.0,0)`,
        {
          '$ts': TypedValues.utf8(s.ts || ''), '$ticker': TypedValues.utf8(s.ticker || ''), '$tf': TypedValues.utf8(s.tf || ''),
          '$entry_price': TypedValues.double(s.entry_price || 0), '$entry_ts': TypedValues.int64(s.entry_ts || 0),
          '$composite': TypedValues.double(s.composite || 0), '$dir': TypedValues.utf8(s.dir || 'neutral'),
          '$methods': TypedValues.utf8(JSON.stringify(s.methods || {})),
        }
      );
    });
    return resp(200, { ok: true });
  }

  const sigPatch = p.match(/^\/signal\/(\d+)$/);
  if (sigPatch && method === 'PATCH') {
    const id = parseInt(sigPatch[1]);
    const patch = body || {};
    const sets = [];
    const params = { '$id': TypedValues.uint64(id) };
    let i = 0;
    for (const [k, v] of Object.entries(patch)) {
      const ph = `$v${i++}`;
      if (typeof v === 'number') {
        sets.push(`${k}=${ph}`);
        params[ph] = Number.isInteger(v) ? TypedValues.int64(v) : TypedValues.double(v);
      } else {
        sets.push(`${k}=${ph}`);
        params[ph] = TypedValues.utf8(String(v));
      }
    }
    if (!sets.length) return resp(200, { ok: true });
    const decls = Object.entries(params).map(([k, v]) =>
      `DECLARE ${k} AS ${v.type === Types.UINT64 ? 'Uint64' : (v.type === Types.INT64 ? 'Int64' : (v.type === Types.DOUBLE ? 'Double' : 'Utf8'))};`
    ).join(' ');
    await withSession(async session => {
      await session.executeQuery(
        `${decls} UPDATE signals SET ${sets.join(',')} WHERE id=$id`, params
      );
    });
    return resp(200, { ok: true });
  }

  if (p === '/signals' && method === 'GET') {
    const { ticker, resolved } = qs;
    const rows = await withSession(async session => {
      let q = 'SELECT * FROM signals WHERE 1=1';
      const params = {};
      const decls = [];
      if (ticker) { q += ' AND ticker=$ticker'; decls.push('DECLARE $ticker AS Utf8;'); params['$ticker'] = TypedValues.utf8(ticker); }
      if (resolved !== undefined) { q += ' AND resolved=$resolved'; decls.push('DECLARE $resolved AS Int64;'); params['$resolved'] = TypedValues.int64(parseInt(resolved)); }
      q += ' ORDER BY id DESC LIMIT 500';
      const { resultSets } = await session.executeQuery(decls.join(' ') + ' ' + q, params);
      return resultSets[0].rows || [];
    });
    const out = rows.map(rowToObj);
    out.forEach(r => { try { r.methods = JSON.parse(r.methods); } catch (_) {} });
    return resp(200, out);
  }

  // ── Weights ──
  if (p === '/weight' && method === 'POST') {
    const w = body || {};
    await withSession(async session => {
      await session.executeQuery(
        `DECLARE $key AS Utf8; DECLARE $ticker AS Utf8; DECLARE $method_id AS Utf8; DECLARE $weight AS Double;
         DECLARE $total AS Int64; DECLARE $sum_quality AS Double; DECLARE $updated_at AS Int64;
         UPSERT INTO weights(key,ticker,method_id,weight,total,sum_quality,updated_at)
         VALUES($key,$ticker,$method_id,$weight,$total,$sum_quality,$updated_at)`,
        {
          '$key': TypedValues.utf8(`${w.ticker}__${w.method_id}`), '$ticker': TypedValues.utf8(w.ticker || ''),
          '$method_id': TypedValues.utf8(w.method_id || ''), '$weight': TypedValues.double(w.weight ?? 0.5),
          '$total': TypedValues.int64(w.total || 0), '$sum_quality': TypedValues.double(w.sum_quality || 0),
          '$updated_at': TypedValues.int64(Date.now()),
        }
      );
    });
    return resp(200, { ok: true });
  }

  if (p === '/weights' && method === 'GET') {
    const { ticker } = qs;
    if (!ticker) return resp(400, { error: 'ticker required' });
    const rows = await withSession(async session => {
      const { resultSets } = await session.executeQuery(
        `DECLARE $ticker AS Utf8; SELECT * FROM weights WHERE ticker=$ticker`,
        { '$ticker': TypedValues.utf8(ticker) }
      );
      return resultSets[0].rows || [];
    });
    return resp(200, rows.map(rowToObj));
  }

  // ── AlgoPack ──
  if (p === '/algopack' && method === 'POST') {
    const { ticker, type, rows } = body || {};
    if (!ticker || !type || !Array.isArray(rows) || !rows.length)
      return resp(400, { error: 'ticker, type, rows required' });
    await withSession(async session => {
      const cutoff = Date.now() - 90 * 86400 * 1000;
      await session.executeQuery(
        `DECLARE $ticker AS Utf8; DECLARE $type AS Utf8; DECLARE $cutoff AS Int64;
         DELETE FROM algopack WHERE ticker=$ticker AND type=$type AND ts<$cutoff`,
        { '$ticker': TypedValues.utf8(ticker), '$type': TypedValues.utf8(type), '$cutoff': TypedValues.int64(cutoff) }
      );
      for (const r of rows) {
        const date = r.tradedate || '';
        const time = r.tradetime || (r.systime ? r.systime.slice(11, 19) : '00:00:00');
        const tsMs = date ? new Date(`${date}T${time}Z`).getTime() : Date.now();
        const key = `${ticker}__${type}__${date}__${time}`;
        await session.executeQuery(
          `DECLARE $key AS Utf8; DECLARE $ticker AS Utf8; DECLARE $type AS Utf8; DECLARE $ts AS Int64;
           DECLARE $date AS Utf8; DECLARE $time AS Utf8; DECLARE $vals AS Utf8;
           UPSERT INTO algopack(key,ticker,type,ts,tradedate,tradetime,vals)
           VALUES($key,$ticker,$type,$ts,$date,$time,$vals)`,
          {
            '$key': TypedValues.utf8(key), '$ticker': TypedValues.utf8(ticker), '$type': TypedValues.utf8(type),
            '$ts': TypedValues.int64(tsMs), '$date': TypedValues.utf8(date), '$time': TypedValues.utf8(time),
            '$vals': TypedValues.utf8(JSON.stringify(r)),
          }
        );
      }
    });
    return resp(200, { ok: true, inserted: rows.length });
  }

  if (p === '/algopack' && method === 'GET') {
    const { ticker, type, days = '30', limit = '2000' } = qs;
    if (!ticker || !type) return resp(400, { error: 'ticker and type required' });
    const from = Date.now() - parseInt(days) * 86400 * 1000;
    const rows = await withSession(async session => {
      const { resultSets } = await session.executeQuery(
        `DECLARE $ticker AS Utf8; DECLARE $type AS Utf8; DECLARE $from AS Int64; DECLARE $limit AS Uint64;
         SELECT vals FROM algopack WHERE ticker=$ticker AND type=$type AND ts>=$from ORDER BY ts ASC LIMIT $limit`,
        { '$ticker': TypedValues.utf8(ticker), '$type': TypedValues.utf8(type), '$from': TypedValues.int64(from), '$limit': TypedValues.uint64(parseInt(limit)) }
      );
      return resultSets[0].rows || [];
    });
    const parsed = rows.map(r => { try { return JSON.parse(rowToObj(r).vals); } catch (_) { return {}; } });
    return resp(200, parsed);
  }

  // ── Percentiles ──
  if (p === '/percentiles' && method === 'POST') {
    const arr = Array.isArray(body) ? body : [body];
    await withSession(async session => {
      for (const r of arr) {
        await session.executeQuery(
          `DECLARE $key AS Utf8; DECLARE $ticker AS Utf8; DECLARE $type AS Utf8; DECLARE $field AS Utf8; DECLARE $window_days AS Int64;
           DECLARE $p10 AS Double; DECLARE $p25 AS Double; DECLARE $p50 AS Double; DECLARE $p75 AS Double; DECLARE $p90 AS Double;
           DECLARE $n AS Int64; DECLARE $updated_at AS Int64;
           UPSERT INTO percentiles(key,ticker,type,field,window_days,p10,p25,p50,p75,p90,n,updated_at)
           VALUES($key,$ticker,$type,$field,$window_days,$p10,$p25,$p50,$p75,$p90,$n,$updated_at)`,
          {
            '$key': TypedValues.utf8(`${r.ticker}__${r.type}__${r.field}__${r.window_days}`),
            '$ticker': TypedValues.utf8(r.ticker || ''), '$type': TypedValues.utf8(r.type || ''), '$field': TypedValues.utf8(r.field || ''),
            '$window_days': TypedValues.int64(r.window_days || 0),
            '$p10': TypedValues.double(r.p10 ?? 0), '$p25': TypedValues.double(r.p25 ?? 0), '$p50': TypedValues.double(r.p50 ?? 0),
            '$p75': TypedValues.double(r.p75 ?? 0), '$p90': TypedValues.double(r.p90 ?? 0),
            '$n': TypedValues.int64(r.n || 0), '$updated_at': TypedValues.int64(Date.now()),
          }
        );
      }
    });
    return resp(200, { ok: true, saved: arr.length });
  }

  if (p === '/percentiles' && method === 'GET') {
    const { ticker, window } = qs;
    if (!ticker) return resp(400, { error: 'ticker required' });
    const rows = await withSession(async session => {
      let q = 'SELECT * FROM percentiles WHERE ticker=$ticker';
      const params = { '$ticker': TypedValues.utf8(ticker) };
      let decls = 'DECLARE $ticker AS Utf8;';
      if (window) { q += ' AND window_days=$window'; decls += ' DECLARE $window AS Int64;'; params['$window'] = TypedValues.int64(parseInt(window)); }
      const { resultSets } = await session.executeQuery(decls + ' ' + q, params);
      return resultSets[0].rows || [];
    });
    return resp(200, rows.map(rowToObj));
  }

  // ── ATR ──
  if (p === '/atr' && method === 'POST') {
    const r = body || {};
    await withSession(async session => {
      await session.executeQuery(
        `DECLARE $key AS Utf8; DECLARE $ticker AS Utf8; DECLARE $tf AS Utf8; DECLARE $atr AS Double;
         DECLARE $atr_pct AS Double; DECLARE $n AS Int64; DECLARE $updated_at AS Int64;
         UPSERT INTO atr(key,ticker,tf,atr,atr_pct,n,updated_at) VALUES($key,$ticker,$tf,$atr,$atr_pct,$n,$updated_at)`,
        {
          '$key': TypedValues.utf8(`${r.ticker}__${r.tf}`), '$ticker': TypedValues.utf8(r.ticker || ''), '$tf': TypedValues.utf8(r.tf || ''),
          '$atr': TypedValues.double(r.atr || 0), '$atr_pct': TypedValues.double(r.atr_pct || 0),
          '$n': TypedValues.int64(r.n || 0), '$updated_at': TypedValues.int64(Date.now()),
        }
      );
    });
    return resp(200, { ok: true });
  }

  if (p === '/atr' && method === 'GET') {
    const { ticker } = qs;
    if (!ticker) return resp(400, { error: 'ticker required' });
    const rows = await withSession(async session => {
      const { resultSets } = await session.executeQuery(
        `DECLARE $ticker AS Utf8; SELECT * FROM atr WHERE ticker=$ticker`,
        { '$ticker': TypedValues.utf8(ticker) }
      );
      return resultSets[0].rows || [];
    });
    return resp(200, rows.map(rowToObj));
  }

  // ── ind_verdicts ──
  if (p === '/indverdict' && method === 'POST') {
    const { ticker, ...verdict } = body || {};
    if (!ticker) return resp(400, { error: 'ticker required' });
    await withSession(async session => {
      await session.executeQuery(
        `DECLARE $ticker AS Utf8; DECLARE $payload AS Utf8; DECLARE $updated_at AS Int64;
         UPSERT INTO ind_verdicts(ticker,payload,updated_at) VALUES($ticker,$payload,$updated_at)`,
        { '$ticker': TypedValues.utf8(ticker), '$payload': TypedValues.utf8(JSON.stringify(verdict)), '$updated_at': TypedValues.int64(Date.now()) }
      );
    });
    return resp(200, { ok: true });
  }

  if (p === '/indverdict' && method === 'GET') {
    const { ticker } = qs;
    if (!ticker) return resp(400, { error: 'ticker required' });
    const row = await withSession(async session => {
      const { resultSets } = await session.executeQuery(
        `DECLARE $ticker AS Utf8; SELECT payload, updated_at FROM ind_verdicts WHERE ticker=$ticker`,
        { '$ticker': TypedValues.utf8(ticker) }
      );
      const rows = resultSets[0].rows || [];
      return rows.length ? rowToObj(rows[0]) : null;
    });
    if (!row) return resp(200, null);
    let verdict; try { verdict = JSON.parse(row.payload); } catch (_) { verdict = {}; }
    return resp(200, { ...verdict, updated_at: row.updated_at });
  }

  return resp(404, { error: 'unknown db route: ' + p });
}

// Преобразует строку результата YDB (с .items / типизированными значениями) в обычный объект.
// ydb-sdk's TableClient resultSets[].rows возвращают объекты вида {columnName: value}
// после использования driver helper — но на всякий случай поддерживаем оба формата.
function rowToObj(row) {
  if (row && typeof row.toJSON === 'function') return row.toJSON();
  return row;
}

// ── Proxy routes (MOEX AlgoPack / T-Invest) ────────────────────────────────
async function handleProxy(path, method, query, headers, rawBody) {
  const fullPath = path + (query ? '?' + query : '');
  const auth = headers['authorization'] || headers['Authorization'] || '';

  if (path.startsWith('/iss/')) {
    const r = await fetch('https://apim.moex.com' + fullPath, {
      headers: { 'Authorization': auth, 'Accept': 'application/json' },
    });
    const text = await r.text();
    return { statusCode: r.status, headers: { ...CORS, 'Content-Type': r.headers.get('content-type') || 'application/json' }, body: text };
  }

  if (path.startsWith('/tinkoff')) {
    const r = await fetch('https://invest-public-api.tinkoff.ru/rest' + fullPath, {
      method,
      headers: { 'Authorization': auth, 'Content-Type': headers['content-type'] || 'application/json' },
      body: method === 'POST' ? rawBody : undefined,
    });
    const text = await r.text();
    return { statusCode: r.status, headers: { ...CORS, 'Content-Type': r.headers.get('content-type') || 'application/json' }, body: text };
  }

  return resp(400, { error: 'Bad request' });
}

// ── Entry point ──────────────────────────────────────────────────────────
// Yandex Cloud Function (HTTP) handler. Включи "Публичный" доступ функции
// или подключи через API Gateway.
module.exports.handler = async function (event) {
  const method = event.httpMethod || 'GET';
  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const path = event.path || '/';
  const qs = event.queryStringParameters || {};
  const headers = event.headers || {};
  let body = null;
  if (event.body) {
    try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body); }
    catch (_) { body = null; }
  }

  try {
    if (path.startsWith('/db/') || path === '/db') {
      return await handleDb(path.replace(/^\/db/, ''), method, qs, body);
    }
    if (path.startsWith('/iss/') || path.startsWith('/tinkoff')) {
      const rawBody = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : undefined;
      const query = Object.entries(qs).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      return await handleProxy(path, method, query, headers, rawBody);
    }
    return resp(404, { error: 'unknown route: ' + path });
  } catch (e) {
    return resp(500, { error: e.message });
  }
};
