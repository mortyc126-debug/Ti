// Cloudflare Worker — бэкенд БондАналитика (пилот).
//
// Что умеет:
//   • GET /status              — диагностика: строк в БД, время последнего сбора
//   • GET /ofz/latest          — последние котировки ОФЗ (one row per secid)
//   • GET /ofz/history?secid=X — история одной бумаги
//   • POST /collect/ofz        — форс-сбор (нужен X-Admin-Token)
//   • cron '0 7 * * *'         — автоматический ежедневный сбор в 10:00 MSK
//
// CORS — разрешаем всем (GET-ы — публичная макро-информация).
// POST /collect требует X-Admin-Token, чтобы кто попало не долбил MOEX.
//
// Архитектура. Один Worker = один бэкенд. D1 — SQLite. Вся схема в
// schema.sql. При добавлении новых коллекторов (корп. облигации,
// курс ЦБ, инфляция) — каждый — новая таблица и новый обработчик в
// router, либо отдельный endpoint /collect/<source>. Cron дёргает всё
// подряд в `scheduled()`.

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
  'Cache-Control': 'no-store',
};

function jsonResp(data, status){
  return new Response(JSON.stringify(data, null, 2), { status: status || 200, headers: JSON_HEADERS });
}
function errResp(msg, status){
  return jsonResp({ error: msg }, status || 400);
}

export default {
  // ───────── HTTP-запросы ─────────
  async fetch(req, env){
    const url = new URL(req.url);
    if(req.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });

    try {
      if(url.pathname === '/status')      return await handleStatus(env);
      if(url.pathname === '/ofz/latest')  return await handleOfzLatest(env, url);
      if(url.pathname === '/ofz/history') return await handleOfzHistory(env, url);
      if(url.pathname === '/collect/ofz' && req.method === 'POST'){
        const token = req.headers.get('X-Admin-Token') || '';
        if(!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return errResp('unauthorized', 401);
        const summary = await collectOfz(env);
        return jsonResp(summary);
      }
      return errResp('Not Found. Endpoints: /status, /ofz/latest, /ofz/history?secid=X, POST /collect/ofz', 404);
    } catch(e){
      return errResp('internal: ' + (e.message || String(e)), 500);
    }
  },

  // ───────── Cron — автоматический ежедневный сбор ─────────
  async scheduled(event, env, ctx){
    ctx.waitUntil((async () => {
      try { await collectOfz(env); }
      catch(e){ console.error('cron collectOfz failed:', e.message); }
    })());
  },
};

// ───────── Endpoints ─────────

async function handleStatus(env){
  // Общая статистика БД
  const [rowsOfz, lastLog, latestDate] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as c FROM ofz_daily').first(),
    env.DB.prepare('SELECT * FROM collection_log ORDER BY started_at DESC LIMIT 1').first(),
    env.DB.prepare('SELECT MAX(date) as d FROM ofz_daily').first(),
  ]);
  return jsonResp({
    ok: true,
    db: {
      ofz_daily_rows: rowsOfz?.c ?? 0,
      ofz_latest_date: latestDate?.d ?? null,
    },
    last_run: lastLog || null,
    version: '0.1-pilot',
  });
}

async function handleOfzLatest(env, url){
  const limit = Math.min(1000, parseInt(url.searchParams.get('limit') || '500', 10));
  // Для каждой бумаги берём самую свежую запись
  const rows = await env.DB.prepare(`
    SELECT o.*
    FROM ofz_daily o
    INNER JOIN (
      SELECT secid, MAX(date) AS maxd FROM ofz_daily GROUP BY secid
    ) m ON o.secid = m.secid AND o.date = m.maxd
    ORDER BY o.mat_date ASC
    LIMIT ?
  `).bind(limit).all();
  return jsonResp({ count: rows.results.length, data: rows.results });
}

async function handleOfzHistory(env, url){
  const secid = url.searchParams.get('secid');
  if(!secid) return errResp('secid required');
  const from = url.searchParams.get('from') || '2020-01-01';
  const to   = url.searchParams.get('to')   || '2099-12-31';
  const rows = await env.DB.prepare(
    'SELECT date, close_price, ytm, coupon FROM ofz_daily WHERE secid = ? AND date BETWEEN ? AND ? ORDER BY date ASC'
  ).bind(secid, from, to).all();
  return jsonResp({ secid, count: rows.results.length, data: rows.results });
}

// ───────── Collector: ОФЗ с MOEX ─────────

async function collectOfz(env){
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const boards = (env.COLLECT_BOARDS || 'TQOB').split(',').map(s => s.trim()).filter(Boolean);
  const base = env.MOEX_BASE || 'https://iss.moex.com';

  const rowsTotal = { inserted: 0, updated: 0 };
  const errors = [];

  for(const board of boards){
    try {
      // Одной страницы хватает для ОФЗ (~40-50 выпусков). Для корпоратов
      // нужна пагинация — её добавим когда включим TQCB.
      const url = `${base}/iss/engines/stock/markets/bonds/boards/${board}/securities.json?iss.meta=off&iss.only=securities,marketdata`;
      const r = await fetch(url, { headers: { 'Accept': 'application/json' }, cf: { cacheTtl: 0 } });
      if(!r.ok){ errors.push(`${board}: HTTP ${r.status}`); continue; }
      const json = await r.json();
      const parsed = parseMoexBoardPage(json);

      const today = new Date().toISOString().slice(0, 10);
      const now = new Date().toISOString();
      for(const b of parsed){
        if(!b.secid) continue;
        // UPSERT: одной записью на (secid, date). Обновляем metadata.
        const res = await env.DB.prepare(`
          INSERT INTO ofz_daily (secid, date, shortname, close_price, ytm, coupon, mat_date, duration_d, issue_size, face_value, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(secid, date) DO UPDATE SET
            shortname = excluded.shortname,
            close_price = excluded.close_price,
            ytm = excluded.ytm,
            coupon = excluded.coupon,
            mat_date = excluded.mat_date,
            duration_d = excluded.duration_d,
            issue_size = excluded.issue_size,
            face_value = excluded.face_value,
            updated_at = excluded.updated_at
        `).bind(
          b.secid, today, b.shortname, b.price, b.ytm, b.coupon, b.matDate,
          b.durationD, b.issueSize, b.faceValue, now
        ).run();
        // D1 не отличает INSERT vs UPDATE в result — считаем общим числом.
        rowsTotal.inserted += res.meta?.rows_written || 0;
      }
    } catch(e){ errors.push(`${board}: ${e.message}`); }
  }

  const finishedAt = new Date().toISOString();
  const status = errors.length === 0 ? 'ok' : (rowsTotal.inserted > 0 ? 'partial' : 'error');
  await env.DB.prepare(
    'INSERT INTO collection_log (started_at, finished_at, source, status, rows_inserted, rows_updated, error, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    startedAt, finishedAt, 'moex_' + boards.join('+'), status,
    rowsTotal.inserted, rowsTotal.updated,
    errors.length ? errors.join(' | ') : null,
    Date.now() - t0
  ).run();

  return { status, boards, rowsTotal, errors, duration_ms: Date.now() - t0 };
}

// Парсер MOEX ISS-страницы (доски облигаций). Почти идентичен клиентскому
// _moexParsePageBoard из app.js — но упрощённый и без лишних полей.
function parseMoexBoardPage(resp){
  const sec = resp.securities || {};
  const md  = resp.marketdata || {};
  const secCols = sec.columns || [], secData = sec.data || [];
  const mdCols  = md.columns  || [], mdData  = md.data  || [];
  const idx = (cols, name) => cols.indexOf(name);
  const sidIdx = idx(secCols, 'SECID');
  const mdSidIdx = idx(mdCols, 'SECID');
  const mdById = {};
  for(const r of mdData){ const id = r[mdSidIdx]; if(id) mdById[id] = r; }
  const _num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
  const out = [];
  for(const r of secData){
    const secid = r[sidIdx]; if(!secid) continue;
    const g  = (n) => r[idx(secCols, n)];
    const mdr = mdById[secid] || [];
    const gm = (n) => mdr[idx(mdCols, n)];
    out.push({
      secid,
      shortname: g('SHORTNAME') || g('SECNAME') || secid,
      coupon: _num(g('COUPONPERCENT')) || _num(g('COUPONVALUE')),
      faceValue: _num(g('FACEVALUE')),
      matDate: g('MATDATE') || null,
      issueSize: _num(g('ISSUESIZE')),
      price: _num(gm('LAST')) || _num(g('PREVWAPRICE')) || _num(g('PREVPRICE')) || _num(g('PREVLEGALCLOSEPRICE')),
      ytm: _num(gm('YIELD')) || _num(g('YIELDATPREVWAPRICE')),
      durationD: _num(gm('DURATION')) || null,
    });
  }
  return out;
}
