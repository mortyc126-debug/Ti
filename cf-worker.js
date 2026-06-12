// Cloudflare Worker — CORS-прокси + D1 база данных для OI·INTEL
//
// НАСТРОЙКА D1 (один раз, 5 минут):
//   1. dash.cloudflare.com → Workers & Pages → твой воркер (oi.marginacall.workers.dev)
//   2. Settings → Bindings → Add → D1 Database
//      Variable name: DB
//      D1 database: нажми "Create new" → название: oisignal → Create
//   3. Edit code → вставь этот файл → Deploy
//   4. Один раз открой: https://oi.marginacall.workers.dev/db/init
//      Должно вернуть {"ok":true,"msg":"schema ready"}
//
// Маршруты:
//   /db/init              GET  — создать таблицы (первый запуск)
//   /db/candles           POST — upsert свечи [{key,ticker,tf,time,o,h,l,cl,vol}]
//   /db/candles?ticker=&tf=&from=  GET — свечи после timestamp
//   /db/signal            POST — новый сигнал → {id}
//   /db/signal/:id        PATCH — обновить сигнал (mfe, mae, quality, resolved)
//   /db/signals?ticker=&resolved=  GET — список сигналов
//   /db/weight            POST — upsert вес метода
//   /db/weights?ticker=   GET  — все веса тикера

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── D1 Schema ──────────────────────────────────────────────────────────────
const SCHEMA = `
CREATE TABLE IF NOT EXISTS candles (
  key    TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  tf     TEXT NOT NULL,
  time   INTEGER NOT NULL,
  o REAL, h REAL, l REAL, cl REAL, vol INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_candles_ttf ON candles(ticker, tf, time);

CREATE TABLE IF NOT EXISTS signals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  ticker      TEXT NOT NULL,
  tf          TEXT NOT NULL,
  entry_price REAL DEFAULT 0,
  entry_ts    INTEGER DEFAULT 0,
  composite   REAL DEFAULT 0,
  dir         TEXT DEFAULT 'neutral',
  methods     TEXT DEFAULT '{}',
  mfe         REAL DEFAULT 0,
  mae         REAL DEFAULT 0,
  quality     REAL,
  resolved    INTEGER DEFAULT 0,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker, resolved);

CREATE TABLE IF NOT EXISTS weights (
  key        TEXT PRIMARY KEY,
  ticker     TEXT NOT NULL,
  method_id  TEXT NOT NULL,
  weight     REAL DEFAULT 0.5,
  total      INTEGER DEFAULT 0,
  sum_quality REAL DEFAULT 0,
  updated_at INTEGER DEFAULT 0
);
`;

// ── D1 Route Handler ───────────────────────────────────────────────────────
async function handleDb(path, req, env) {
  if (!env.DB) return json({ error: 'D1 binding DB not configured. See worker setup instructions.' }, 503);

  const p = path.replace(/^\/db/, '');

  // Init schema
  if (p === '/init') {
    await env.DB.exec(SCHEMA);
    return json({ ok: true, msg: 'schema ready' });
  }

  // ── Candles ──
  if (p === '/candles' && req.method === 'POST') {
    const rows = await req.json();
    if (!Array.isArray(rows) || !rows.length) return json({ ok: true, inserted: 0 });
    // Batch upsert, по 100 строк за раз
    const chunks = [];
    for (let i = 0; i < rows.length; i += 100) chunks.push(rows.slice(i, i + 100));
    for (const chunk of chunks) {
      const stmts = chunk.map(r =>
        env.DB.prepare(
          'INSERT OR REPLACE INTO candles(key,ticker,tf,time,o,h,l,cl,vol) VALUES(?,?,?,?,?,?,?,?,?)'
        ).bind(r.key, r.ticker, r.tf, r.time, r.o, r.h, r.l, r.cl, r.vol ?? 0)
      );
      await env.DB.batch(stmts);
    }
    return json({ ok: true, inserted: rows.length });
  }

  if (p.startsWith('/candles') && req.method === 'GET') {
    const u = new URL(req.url);
    const ticker = u.searchParams.get('ticker');
    const tf     = u.searchParams.get('tf');
    const from   = parseInt(u.searchParams.get('from') || '0');
    if (!ticker || !tf) return json({ error: 'ticker and tf required' }, 400);
    const { results } = await env.DB.prepare(
      'SELECT * FROM candles WHERE ticker=? AND tf=? AND time>=? ORDER BY time ASC LIMIT 2000'
    ).bind(ticker, tf, from).all();
    return json(results);
  }

  // ── Signals ──
  if (p === '/signal' && req.method === 'POST') {
    const s = await req.json();
    const r = await env.DB.prepare(
      `INSERT INTO signals(ts,ticker,tf,entry_price,entry_ts,composite,dir,methods)
       VALUES(?,?,?,?,?,?,?,?)`
    ).bind(s.ts, s.ticker, s.tf, s.entry_price ?? 0, s.entry_ts ?? 0,
           s.composite ?? 0, s.dir ?? 'neutral', JSON.stringify(s.methods ?? {})).run();
    return json({ ok: true, id: r.meta.last_row_id });
  }

  const sigPatch = p.match(/^\/signal\/(\d+)$/);
  if (sigPatch && req.method === 'PATCH') {
    const id = parseInt(sigPatch[1]);
    const patch = await req.json();
    const fields = Object.keys(patch).map(k => `${k}=?`).join(',');
    const vals   = Object.values(patch);
    await env.DB.prepare(`UPDATE signals SET ${fields} WHERE id=?`).bind(...vals, id).run();
    return json({ ok: true });
  }

  if (p.startsWith('/signals') && req.method === 'GET') {
    const u = new URL(req.url);
    const ticker   = u.searchParams.get('ticker');
    const resolved = u.searchParams.get('resolved'); // '0' или '1' или null
    let q = 'SELECT * FROM signals WHERE 1=1';
    const binds = [];
    if (ticker)   { q += ' AND ticker=?';   binds.push(ticker); }
    if (resolved !== null) { q += ' AND resolved=?'; binds.push(parseInt(resolved)); }
    q += ' ORDER BY id DESC LIMIT 500';
    const { results } = await env.DB.prepare(q).bind(...binds).all();
    results.forEach(r => { try { r.methods = JSON.parse(r.methods); } catch(_){} });
    return json(results);
  }

  // ── Weights ──
  if (p === '/weight' && req.method === 'POST') {
    const w = await req.json();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO weights(key,ticker,method_id,weight,total,sum_quality,updated_at)
       VALUES(?,?,?,?,?,?,?)`
    ).bind(`${w.ticker}__${w.method_id}`, w.ticker, w.method_id,
           w.weight ?? 0.5, w.total ?? 0, w.sum_quality ?? 0, Date.now()).run();
    return json({ ok: true });
  }

  if (p.startsWith('/weights') && req.method === 'GET') {
    const ticker = new URL(req.url).searchParams.get('ticker');
    if (!ticker) return json({ error: 'ticker required' }, 400);
    const { results } = await env.DB.prepare('SELECT * FROM weights WHERE ticker=?').bind(ticker).all();
    return json(results);
  }

  return json({ error: 'unknown db route: ' + p }, 404);
}

// ── Main Handler ───────────────────────────────────────────────────────────
export default {
  async fetch(req, env) {
    const url  = new URL(req.url);
    const path = url.pathname;

    // CORS preflight для всех /db/ маршрутов
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // D1 роуты
    if (path.startsWith('/db/') || path === '/db') {
      return handleDb(path, req, env).catch(e => json({ error: e.message }, 500));
    }

    const fullPath = path + url.search;

    // OI·INTEL — MOEX AlgoPack
    if (path.startsWith('/iss/')) {
      const auth = req.headers.get('Authorization') || '';
      const resp = await fetch('https://apim.moex.com' + fullPath, {
        headers: { 'Authorization': auth, 'Accept': 'application/json' },
      });
      return new Response(resp.body, {
        status: resp.status,
        headers: { ...CORS, 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
      });
    }

    // OI·INTEL — T-Invest
    if (path.startsWith('/tinkoff')) {
      const auth = req.headers.get('Authorization') || '';
      const body = req.method === 'POST' ? await req.arrayBuffer() : undefined;
      const resp = await fetch('https://invest-public-api.tinkoff.ru/rest' + fullPath, {
        method: req.method,
        headers: { 'Authorization': auth, 'Content-Type': req.headers.get('Content-Type') || 'application/json' },
        body,
      });
      return new Response(resp.body, {
        status: resp.status,
        headers: { ...CORS, 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
      });
    }

    // БондАналитик — CORS-прокси для ГИР БО / ЦБ / ФНС
    let target = url.searchParams.get('u');

    const ALLOWED = [
      /^https:\/\/bo\.nalog\.gov\.ru\//,
      /^https:\/\/(www\.)?audit-it\.ru\//,
      /^https:\/\/(www\.)?buxbalans\.ru\//,
      /^https:\/\/(www\.)?cbr\.ru\/dataservice\//,
      /^https:\/\/(www\.)?cbr\.ru\/Content\/Document\/File\//,
      /^https:\/\/api\.stlouisfed\.org\/fred\//,
      /^https:\/\/query[12]\.finance\.yahoo\.com\//,
      /^https:\/\/stooq\.com\//,
      /^https:\/\/data-api\.ecb\.europa\.eu\//,
    ];

    if (!target) {
      if (path.startsWith('/nbo') || path.startsWith('/advanced-search'))
        target = 'https://bo.nalog.gov.ru' + fullPath;
      else if (path.startsWith('/buh_otchet') || path.startsWith('/search') || path.startsWith('/contragent'))
        target = 'https://www.audit-it.ru' + fullPath;
      else if (path.startsWith('/dataservice') || path.startsWith('/Content/Document/File/'))
        target = 'https://www.cbr.ru' + fullPath;
      else if (path.startsWith('/fred/'))
        target = 'https://api.stlouisfed.org' + fullPath;
      else if (path.startsWith('/v7/finance/') || path.startsWith('/v8/finance/'))
        target = 'https://query1.finance.yahoo.com' + fullPath;
      else if (path.startsWith('/q/d/l/'))
        target = 'https://stooq.com' + fullPath;
      else if (/^\/\d{10}(\d{2})?\.html$/.test(path))
        target = 'https://buxbalans.ru' + fullPath;
    }

    if (!target || !ALLOWED.some(re => re.test(target))) {
      return new Response('Bad request', { status: 400, headers: CORS });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    try {
      let upstream = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          upstream = await fetch(target, {
            method: req.method,
            headers: {
              'Accept': target.includes('cbr.ru/dataservice') || target.includes('api.stlouisfed.org') || target.includes('finance.yahoo.com')
                ? 'application/json, */*;q=0.1'
                : target.includes('stooq.com') ? 'text/csv, text/plain, */*;q=0.1'
                : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.7',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
              'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
              ...(target.includes('audit-it.ru') ? { 'Referer': 'https://www.audit-it.ru/' } : {}),
            },
            cf: { cacheTtl: 600, cacheTtlByStatus: { '200-299': 600, '300-599': 0 } },
          });
          if (![502, 503, 504, 522, 524].includes(upstream.status)) break;
        } catch (_) {}
        if (attempt < 2) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      }
      if (!upstream) return new Response('Upstream unreachable', { status: 502, headers: CORS });

      const hdrs = new Headers(upstream.headers);
      Object.entries(CORS).forEach(([k, v]) => hdrs.set(k, v));
      hdrs.delete('Set-Cookie');
      hdrs.delete('Strict-Transport-Security');
      hdrs.set('Cache-Control', upstream.status < 300 ? 'public, max-age=600' : 'no-store');
      return new Response(upstream.body, { status: upstream.status, headers: hdrs });
    } catch (e) {
      return new Response('Error: ' + e.message, { status: 502, headers: CORS });
    }
  },
};
