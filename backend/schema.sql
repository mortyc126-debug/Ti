-- БондАналитик · бэкенд · D1 (SQLite) schema
-- Выполняется одним вызовом `npx wrangler d1 execute <db> --file=backend/schema.sql`
--
-- Пилотная схема: ежедневные котировки акций MOEX (доска TQBR) и
-- фьючерсов на акции (FORTS). Основная аналитическая ценность — basis
-- между спотовой ценой акции и ближайшим фьючерсом на неё.

-- ── Ежедневные котировки акций (spot, TQBR) ───────────────────────────
CREATE TABLE IF NOT EXISTS stock_daily (
  secid        TEXT NOT NULL,        -- SBER, GAZP, LKOH, YNDX и т.д.
  date         TEXT NOT NULL,        -- YYYY-MM-DD
  shortname    TEXT,                 -- «Сбер», «Газпром»
  price        REAL,                 -- LAST или PREVPRICE, руб за акцию
  prev_close   REAL,                 -- закрытие прошлого дня
  open_price   REAL,
  high_price   REAL,
  low_price    REAL,
  volume_rub   REAL,                 -- оборот в рублях
  issue_size   INTEGER,              -- кол-во акций в обращении (для market cap)
  face_value   REAL,                 -- номинал
  updated_at   TEXT NOT NULL,        -- ISO timestamp
  PRIMARY KEY (secid, date)
);
CREATE INDEX IF NOT EXISTS idx_stock_date ON stock_daily(date);
CREATE INDEX IF NOT EXISTS idx_stock_secid ON stock_daily(secid);

-- ── Ежедневные котировки фьючерсов на акции (FORTS) ──────────────────
-- secid в FORTS: "SBER-3.26" / "GAZP-6.26" / короткий код "SBRH6"
-- asset_code — код базовой акции (SBER, GAZP). По нему линкуем со stock_daily.
CREATE TABLE IF NOT EXISTS futures_daily (
  secid              TEXT NOT NULL,
  date               TEXT NOT NULL,
  asset_code         TEXT,           -- SBER / GAZP — связь с акцией
  shortname          TEXT,
  price              REAL,           -- LAST, в пунктах (не рублях — см. step_price)
  prev_close         REAL,
  last_delivery_date TEXT,           -- YYYY-MM-DD, дата экспирации
  step_price         REAL,           -- рублей за 1 пункт изменения цены
  min_step           REAL,           -- минимальный шаг цены
  lot_size           INTEGER,        -- акций в одном контракте (обычно 100)
  volume_rub         REAL,
  open_position      INTEGER,        -- открытые позиции, контрактов
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (secid, date)
);
CREATE INDEX IF NOT EXISTS idx_fut_asset ON futures_daily(asset_code);
CREATE INDEX IF NOT EXISTS idx_fut_expiry ON futures_daily(last_delivery_date);
CREATE INDEX IF NOT EXISTS idx_fut_date ON futures_daily(date);

-- ── Лог запусков cron'а ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collection_log (
  run_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  source        TEXT NOT NULL,         -- 'moex_tqbr', 'moex_forts' и т.д.
  status        TEXT NOT NULL,         -- 'ok', 'partial', 'error'
  rows_inserted INTEGER DEFAULT 0,
  rows_updated  INTEGER DEFAULT 0,
  error         TEXT,
  duration_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_log_started ON collection_log(started_at);
CREATE INDEX IF NOT EXISTS idx_log_source ON collection_log(source);

-- ── Ежедневные котировки облигаций (TQCB корпораты + TQOB ОФЗ) ────────
-- Главная таблица для ВДО-аналитики. По каждой бумаге раз в день
-- снимается срез с ценой, доходностью, дюрацией, оборотом, статусом
-- и параметрами выпуска (купон, сроки, оферта). На этой таблице
-- строятся: spread-to-OFZ, метрика стресса, event-study и survival.
--
-- secid — уникальный идентификатор MOEX (RU000A106DZ4, SU26221RMFS0).
-- board — TQCB / TQOB. По ней узнаём корпорат это или ОФЗ.
-- emitent_inn — связка с reportsDB и rating_actions.
CREATE TABLE IF NOT EXISTS bond_daily (
  secid              TEXT NOT NULL,
  date               TEXT NOT NULL,        -- YYYY-MM-DD
  isin               TEXT,
  shortname          TEXT,
  board              TEXT,                 -- 'TQCB' | 'TQOB'
  -- Цены (% от номинала)
  price              REAL,                 -- LAST или PREVPRICE
  prev_close         REAL,
  open_price         REAL,
  high_price         REAL,
  low_price          REAL,
  -- Доходности и риск-метрики
  yield              REAL,                 -- YTM, %
  duration_days      INTEGER,              -- Macaulay duration, дней
  accrued_int        REAL,                 -- НКД, ₽ за бумагу
  -- Объёмы торгов
  volume_rub         REAL,                 -- оборот за день, ₽
  num_trades         INTEGER,
  -- Параметры выпуска
  face_value         REAL,
  face_unit          TEXT,                 -- 'SUR', 'USD' и т.д.
  coupon_pct         REAL,                 -- купонная ставка, %
  coupon_value       REAL,                 -- купон, ₽ на бумагу
  coupon_period_days INTEGER,
  next_coupon_date   TEXT,
  mat_date           TEXT,                 -- дата погашения
  offer_date         TEXT,                 -- ближайшая оферта (put/call)
  issue_size         REAL,                 -- размер выпуска, шт.
  list_level         INTEGER,              -- 1/2/3
  status             TEXT,                 -- 'A' | 'S' | 'D' | 'N'
  -- Эмитент (для матчинга с reportsDB и АКРА/RAEX)
  emitent_name       TEXT,
  emitent_inn        TEXT,
  -- Метаданные
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (secid, date)
);
CREATE INDEX IF NOT EXISTS idx_bond_date    ON bond_daily(date);
CREATE INDEX IF NOT EXISTS idx_bond_board   ON bond_daily(board);
CREATE INDEX IF NOT EXISTS idx_bond_mat     ON bond_daily(mat_date);
CREATE INDEX IF NOT EXISTS idx_bond_offer   ON bond_daily(offer_date);
CREATE INDEX IF NOT EXISTS idx_bond_inn     ON bond_daily(emitent_inn);
CREATE INDEX IF NOT EXISTS idx_bond_status  ON bond_daily(status);
CREATE INDEX IF NOT EXISTS idx_bond_yield   ON bond_daily(yield);
