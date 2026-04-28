-- Migration TRACK A → таблицы для intraday-сбора стакана и тиков FORTS.
-- Идемпотентно: безопасно запускать повторно (CREATE TABLE/INDEX IF NOT EXISTS).
-- Все ALTER на существующих таблицах (если когда-нибудь понадобятся) делает
-- worker.js в trackACollector через try/catch — здесь только новые сущности.
--
-- Способы запуска:
--
-- 1) Через wrangler:
--    npx wrangler d1 execute coldline --file=backend/migrations/A_orderbook.sql --remote
--
-- 2) Через Cloudflare Dashboard (если wrangler ругается):
--    dash.cloudflare.com → Storage & Databases → D1 → coldline →
--    вкладка Console → вставить ВЕСЬ текст ниже → Execute.
--
-- Что делает миграция:
--   • orderbook_snapshots — срезы стакана (10 уровней) каждые ~10 мин;
--   • intraday_trades_5m  — 5-минутные агрегаты тиковых сделок;
--   • orderbook_watchlist — список «горячих» FORTS-тикеров для сбора.

-- ── Срез стакана: 1 строка = 1 снапшот = 1 секьюрити ──────────────────
-- best_bid/best_ask/spread_pct сразу денормализованы для быстрых запросов
-- в /futures/{secid}/depth_signal без парсинга raw_levels.
CREATE TABLE IF NOT EXISTS orderbook_snapshots (
  secid       TEXT NOT NULL,
  ts          TEXT NOT NULL,        -- ISO timestamp (UTC)
  best_bid    REAL,
  best_ask    REAL,
  mid         REAL,                 -- (best_bid + best_ask)/2
  spread_pct  REAL,                 -- (ask - bid)/mid * 100
  bid_volume  INTEGER,              -- сумма qty на 10 уровнях bid
  ask_volume  INTEGER,
  imbalance   REAL,                 -- (bid_vol - ask_vol)/(bid_vol + ask_vol)
  depth_5pct  INTEGER,              -- объём в радиусе 5 % от mid (bid+ask)
  raw_levels  TEXT,                 -- JSON: [{px, qty, side}, ...]
  PRIMARY KEY (secid, ts)
);
CREATE INDEX IF NOT EXISTS idx_ob_secid_ts ON orderbook_snapshots(secid, ts);
CREATE INDEX IF NOT EXISTS idx_ob_ts       ON orderbook_snapshots(ts);

-- ── 5-минутные агрегаты сделок ────────────────────────────────────────
-- Дампить каждый тик дорого (~1k тиков/мин по SBER), поэтому хранение
-- ведётся 5-минутными свечами с разделением buy/sell по BUYSELL флагу.
-- VWAP и agg_ratio считаются в коллекторе.
CREATE TABLE IF NOT EXISTS intraday_trades_5m (
  secid          TEXT NOT NULL,
  bucket         TEXT NOT NULL,     -- ISO timestamp начала 5-минутки (UTC)
  trades_count   INTEGER,
  volume_lots    INTEGER,
  volume_rub     REAL,
  vwap           REAL,
  high           REAL,
  low            REAL,
  buy_volume     INTEGER,           -- сделки по ask (агрессивные покупки)
  sell_volume    INTEGER,           -- сделки по bid (агрессивные продажи)
  agg_ratio      REAL,              -- buy / (buy + sell)
  PRIMARY KEY (secid, bucket)
);
CREATE INDEX IF NOT EXISTS idx_it5_secid  ON intraday_trades_5m(secid);
CREATE INDEX IF NOT EXISTS idx_it5_bucket ON intraday_trades_5m(bucket);

-- ── Watchlist «горячих» фьючерсов для регулярного сбора ───────────────
-- enabled=0 временно отключает сбор без удаления записи. Заполняется
-- руками или через POST /collect/orderbook/seed (топ по обороту).
CREATE TABLE IF NOT EXISTS orderbook_watchlist (
  secid       TEXT PRIMARY KEY,
  asset_code  TEXT,                 -- SBER/GAZP/LKOH — для группировки
  added_at    TEXT NOT NULL,
  enabled     INTEGER DEFAULT 1,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_obw_enabled ON orderbook_watchlist(enabled);
