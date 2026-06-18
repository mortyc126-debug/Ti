/**
 * cf-collector/worker.js — общая база расчётов композита по всем тикерам
 * MOEX (D1) + тонкий HTTP API над ней.
 *
 * Пишет collector_worker.py (раз в день, по всему рынку), читает trader.py
 * (перед тем как разрешить реальную торговлю по новому тикеру из
 * MEGA-ALERTS) — оба ходят сюда по HTTP, сама логика композита и бэктеста
 * остаётся в Python (oi_composite_strategy.py), здесь только хранение.
 *
 * Авторизация — общий секрет в заголовке X-API-Key, должен совпадать с
 * переменной окружения API_KEY (wrangler secret).
 *
 * Endpoints:
 *   POST /snapshot              — upsert одной записи (см. schema.sql)
 *   GET  /history/:ticker?days= — последние N дней по тикеру (по умолч. 90)
 *   GET  /latest/:ticker        — последняя запись по тикеру
 *   GET  /tickers               — список тикеров, для которых есть данные
 */

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function checkAuth(request, env) {
  return request.headers.get("X-API-Key") === env.API_KEY;
}

async function handleSnapshot(request, env) {
  const body = await request.json();
  const required = ["ticker", "date", "composite", "scores", "regime", "rolling_quality"];
  for (const field of required) {
    if (body[field] === undefined || body[field] === null) {
      return jsonResponse({ error: `missing field: ${field}` }, 400);
    }
  }
  await env.DB.prepare(
    `INSERT INTO snapshots
       (ticker, date, composite, scores, regime, rolling_quality, backtest_quality, backtest_trades, live, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticker, date) DO UPDATE SET
       composite=excluded.composite,
       scores=excluded.scores,
       regime=excluded.regime,
       rolling_quality=excluded.rolling_quality,
       backtest_quality=excluded.backtest_quality,
       backtest_trades=excluded.backtest_trades,
       live=excluded.live,
       updated_at=excluded.updated_at`
  ).bind(
    body.ticker,
    body.date,
    body.composite,
    JSON.stringify(body.scores),
    body.regime,
    body.rolling_quality,
    body.backtest_quality ?? null,
    body.backtest_trades ?? null,
    body.live ? 1 : 0,
    new Date().toISOString()
  ).run();
  return jsonResponse({ ok: true });
}

async function handleHistory(ticker, request, env) {
  const days = parseInt(new URL(request.url).searchParams.get("days") || "90", 10);
  const rows = await env.DB.prepare(
    `SELECT date, composite, scores, regime, rolling_quality, backtest_quality, backtest_trades, live, updated_at
     FROM snapshots WHERE ticker = ? ORDER BY date DESC LIMIT ?`
  ).bind(ticker, days).all();
  return jsonResponse({
    ticker,
    history: rows.results.map((r) => ({ ...r, scores: JSON.parse(r.scores) })),
  });
}

async function handleLatest(ticker, env) {
  const row = await env.DB.prepare(
    `SELECT date, composite, scores, regime, rolling_quality, backtest_quality, backtest_trades, live, updated_at
     FROM snapshots WHERE ticker = ? ORDER BY date DESC LIMIT 1`
  ).bind(ticker).first();
  if (!row) return jsonResponse({ ticker, latest: null });
  return jsonResponse({ ticker, latest: { ...row, scores: JSON.parse(row.scores) } });
}

async function handleTickers(env) {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT ticker FROM snapshots ORDER BY ticker`
  ).all();
  return jsonResponse({ tickers: rows.results.map((r) => r.ticker) });
}

export default {
  async fetch(request, env) {
    if (!checkAuth(request, env)) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (request.method === "POST" && parts[0] === "snapshot") {
        return await handleSnapshot(request, env);
      }
      if (request.method === "GET" && parts[0] === "history" && parts[1]) {
        return await handleHistory(parts[1], request, env);
      }
      if (request.method === "GET" && parts[0] === "latest" && parts[1]) {
        return await handleLatest(parts[1], env);
      }
      if (request.method === "GET" && parts[0] === "tickers") {
        return await handleTickers(env);
      }
      return jsonResponse({ error: "not found" }, 404);
    } catch (ex) {
      return jsonResponse({ error: String(ex) }, 500);
    }
  },
};
