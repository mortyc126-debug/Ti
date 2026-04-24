-- БондАналитик · бэкенд · D1 (SQLite) schema
-- Выполняется одним вызовом `npx wrangler d1 execute <db> --file=backend/schema.sql`
--
-- Минимальная стартовая схема для пилота: ежедневные котировки ОФЗ
-- с Т+ доски MOEX + лог запусков cron'а. Остальные таблицы добавляем
-- по мере переноса данных с localStorage.

-- ── Ежедневные котировки ОФЗ ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ofz_daily (
  secid       TEXT NOT NULL,        -- SU26238RMFS4, SU26233RMFS5 и т.д.
  date        TEXT NOT NULL,        -- YYYY-MM-DD (дата срезa)
  shortname   TEXT,                 -- «ОФЗ 26238» и т.п.
  close_price REAL,                 -- PREVWAPRICE или LAST, % от номинала
  ytm         REAL,                 -- YIELDATPREVWAPRICE, доходность % годовых
  coupon      REAL,                 -- текущий купон, % годовых
  mat_date    TEXT,                 -- YYYY-MM-DD, дата погашения
  duration_d  INTEGER,              -- дюрация в днях
  issue_size  INTEGER,              -- кол-во бумаг в выпуске
  face_value  REAL,                 -- номинал, обычно 1000
  updated_at  TEXT NOT NULL,        -- ISO-timestamp последнего апдейта строки
  PRIMARY KEY (secid, date)
);
CREATE INDEX IF NOT EXISTS idx_ofz_date ON ofz_daily(date);
CREATE INDEX IF NOT EXISTS idx_ofz_secid ON ofz_daily(secid);
CREATE INDEX IF NOT EXISTS idx_ofz_mat ON ofz_daily(mat_date);

-- ── Лог запусков cron'а ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collection_log (
  run_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,         -- ISO
  finished_at   TEXT,
  source        TEXT NOT NULL,         -- 'moex_tqob', 'moex_tqcb', 'cbr_rates' и т.д.
  status        TEXT NOT NULL,         -- 'ok', 'partial', 'error'
  rows_inserted INTEGER DEFAULT 0,
  rows_updated  INTEGER DEFAULT 0,
  error         TEXT,
  duration_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_log_started ON collection_log(started_at);
CREATE INDEX IF NOT EXISTS idx_log_source ON collection_log(source);
