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

-- ── Справочник эмитентов ──────────────────────────────────────────────
-- Единая точка истины: ИНН ↔ имя ↔ тикер акции ↔ сектор ↔ ОКВЭД ↔ регион.
-- Всё остальное (отчёты, события, связи, графики цен) ссылается сюда
-- по inn. Источники: MOEX issuers + ГИР БО meta + e-disclosure cards.
-- Обновляется кроном раз в неделю; ИНН — из bond_daily.emitent_inn,
-- ОКВЭД и регион — из ГИР БО, тикер — из MOEX securities.
CREATE TABLE IF NOT EXISTS issuers (
  inn          TEXT PRIMARY KEY,         -- 7736050003
  ogrn         TEXT,                     -- 1027700070518
  name         TEXT,                     -- ПАО «Газпром»
  short_name   TEXT,                     -- Газпром
  ticker       TEXT,                     -- GAZP (если торгуется акцией)
  isin_eq      TEXT,                     -- ISIN акции (RU0007661625)
  sector       TEXT,                     -- наша 15-секторная классификация
  okved        TEXT,                     -- 35.21
  okved_name   TEXT,
  region       TEXT,                     -- регион регистрации
  country      TEXT,                     -- по умолчанию RU
  founded      TEXT,                     -- год регистрации
  bonds_count  INTEGER DEFAULT 0,        -- активных выпусков (денормализованный счётчик)
  aliases      TEXT,                     -- JSON-массив дополнительных написаний
                                         --   ["Газпром", "Gazprom", "ОАО Газпром"]
  meta         TEXT,                     -- JSON, всё лишнее (telegram, сайт, ИКАО ...)
  source       TEXT,                     -- 'moex' | 'girbo' | 'edisc' | 'manual'
  kind         TEXT,                     -- 'corporate' | 'subfederal' | 'municipal' | 'federal' | 'bank'
                                         -- corporate сдают РСБУ по 402-ФЗ (ГИР БО/buxbalans),
                                         -- остальные — нет: subfederal/municipal/federal —
                                         -- бюджет 86н, bank — формы ЦБ 101/102. Очередь
                                         -- reports_queue фильтрует по kind='corporate'.
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issuers_ticker ON issuers(ticker);
CREATE INDEX IF NOT EXISTS idx_issuers_sector ON issuers(sector);
CREATE INDEX IF NOT EXISTS idx_issuers_name   ON issuers(short_name);
CREATE INDEX IF NOT EXISTS idx_issuers_kind   ON issuers(kind);

-- ── Известные ISIN/secid акций по ИНН ─────────────────────────────────
-- Один эмитент может иметь несколько secid акций (обычная + префы:
-- SBER + SBERP, TRMK + TRMKP). Issuers.ticker — основная (обычная);
-- этот линкер — для всех.
CREATE TABLE IF NOT EXISTS issuer_securities (
  inn      TEXT NOT NULL,
  secid    TEXT NOT NULL,                -- SBER, SBERP, GAZP
  isin     TEXT,
  kind     TEXT,                         -- 'common' | 'preferred' | 'depository_receipt'
  board    TEXT,                         -- 'TQBR' | 'TQTF' | 'TQIF'
  PRIMARY KEY (inn, secid)
);
CREATE INDEX IF NOT EXISTS idx_issec_secid ON issuer_securities(secid);

-- ── Финансовая отчётность эмитентов (РСБУ из ГИР БО) ──────────────────
-- Одна строка = (ИНН, год, тип отчётности). Значения хранятся в МЛРД ₽
-- (внутренняя единица БондАналитика). Источник по умолчанию — ГИР БО,
-- но схема готова и для аудит-it / e-disclosure / ручного ввода.
--
-- Зачем именно длинные колонки, а не JSON: SQL-агрегации (медианы по
-- отрасли, ранжирование, топ-N по EBITDA-марже) гораздо быстрее идут по
-- столбцам. Все 13 наших коротких метрик (rev/ebitda/ebit/np/...) +
-- сырые строки ГИР БО (на случай если понадобится восстановить
-- расчёт) ложатся в одну строку.
CREATE TABLE IF NOT EXISTS issuer_reports (
  inn          TEXT NOT NULL,           -- ИНН эмитента, FK на issuers
  fy_year      INTEGER NOT NULL,        -- финансовый год (например 2024)
  period       TEXT NOT NULL DEFAULT 'FY', -- 'FY' | 'H1' | '9M' | 'Q1' | 'Q3'
  std          TEXT NOT NULL DEFAULT 'РСБУ', -- 'РСБУ' | 'МСФО'
  -- Все суммы в МЛРД ₽
  rev          REAL,                    -- Выручка (стр. 2110)
  ebitda       REAL,                    -- EBITDA (расчётная)
  ebit         REAL,                    -- Операц. прибыль (стр. 2200)
  np           REAL,                    -- Чистая прибыль (стр. 2400)
  int_exp      REAL,                    -- Процентные расходы (стр. 2330, по модулю)
  tax_exp      REAL,                    -- Налог на прибыль (стр. 2410)
  assets       REAL,                    -- Всего активов (стр. 1600)
  ca           REAL,                    -- Оборотные активы (стр. 1200)
  cl           REAL,                    -- Краткосрочные обязательства (стр. 1500)
  debt         REAL,                    -- Общий долг (стр. 1410+1510)
  cash         REAL,                    -- Денежные средства (стр. 1250)
  ret          REAL,                    -- Нераспределённая прибыль (стр. 1370)
  eq           REAL,                    -- Собственный капитал (стр. 1300)
  -- Производные коэффициенты (заполняются триггером или коллектором)
  roa_pct      REAL,                    -- np / assets × 100
  ros_pct      REAL,                    -- np / rev × 100
  ebitda_marg  REAL,                    -- ebitda / rev × 100
  net_debt_eq  REAL,                    -- (debt - cash) / eq
  -- Метаданные
  source       TEXT NOT NULL DEFAULT 'girbo', -- 'girbo' | 'audit-it' | 'edisc' | 'manual'
  raw          TEXT,                    -- сырой JSON ГИР БО (current<code>) — для дебага
  fetched_at   TEXT NOT NULL,
  PRIMARY KEY (inn, fy_year, period, std)
);
CREATE INDEX IF NOT EXISTS idx_reports_inn   ON issuer_reports(inn);
CREATE INDEX IF NOT EXISTS idx_reports_year  ON issuer_reports(fy_year);
CREATE INDEX IF NOT EXISTS idx_reports_fetch ON issuer_reports(fetched_at);

-- Очередь сбора отчётности. Используется коллектором collectReports
-- чтобы не дёргать ГИР БО для одних и тех же ИНН на каждом запуске,
-- а равномерно проходить весь список эмитентов раз в N дней.
CREATE TABLE IF NOT EXISTS reports_queue (
  inn            TEXT PRIMARY KEY,
  last_attempt   TEXT,                  -- когда последний раз пытались
  last_success   TEXT,                  -- когда последний раз успешно
  attempts       INTEGER DEFAULT 0,     -- неудачных попыток подряд
  last_error     TEXT,
  next_due       TEXT,                  -- когда снова можно дёрнуть
  priority       INTEGER DEFAULT 0      -- 0 = обычный, выше = чаще
);
CREATE INDEX IF NOT EXISTS idx_queue_due ON reports_queue(next_due);

-- ── Кеш AI-вызовов ────────────────────────────────────────────────────
-- Чтобы не платить за один и тот же запрос дважды (особенно Grok с Live
-- Search — стоимость порядка $0.015/1k токенов, плюс за поиск). Ключ
-- `cache_key` = sha256(engine|schema|payload) — payload обычно {inn,
-- expected_year}. TTL 30 дней — данные ФНС не меняются чаще.
CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key    TEXT PRIMARY KEY,         -- sha256
  engine       TEXT NOT NULL,            -- 'grok' | 'cerebras'
  schema       TEXT NOT NULL,            -- 'report' | 'event' | 'supplier'
  inn          TEXT,                     -- для группировки/чистки
  response     TEXT NOT NULL,            -- сырой JSON из LLM
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  fetched_at   TEXT NOT NULL,
  ttl_until    TEXT NOT NULL             -- после этой даты считается просроченным
);
CREATE INDEX IF NOT EXISTS idx_aic_inn   ON ai_cache(inn);
CREATE INDEX IF NOT EXISTS idx_aic_ttl   ON ai_cache(ttl_until);
CREATE INDEX IF NOT EXISTS idx_aic_engin ON ai_cache(engine);

-- Журнал использования AI — для бюджета и мониторинга. На каждый
-- успешный/неуспешный вызов одна строка. По нему /status считает
-- ai_calls_today / ai_tokens_today.
CREATE TABLE IF NOT EXISTS ai_calls_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  engine      TEXT NOT NULL,
  schema      TEXT,
  inn         TEXT,
  ok          INTEGER NOT NULL DEFAULT 0,  -- 1 если вернул валидный JSON
  cache_hit   INTEGER NOT NULL DEFAULT 0,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  duration_ms INTEGER,
  error       TEXT,
  called_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aic_log_at  ON ai_calls_log(called_at);
CREATE INDEX IF NOT EXISTS idx_aic_log_eng ON ai_calls_log(engine);
