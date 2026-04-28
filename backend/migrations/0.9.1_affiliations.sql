-- Migration 0.9.1 → добавляет таблицу issuer_affiliations + индексы.
-- Идемпотентно: безопасно запускать повторно.
--
-- Колонку issuers.kind не трогаем — её автоматически добавляет
-- worker.js при первом collectIssuers (ALTER TABLE в try/catch).
--
-- Способы запуска:
--
-- 1) Через wrangler:
--    npx wrangler d1 execute coldline --file=backend/migrations/0.9.1_affiliations.sql --remote
--
-- 2) Через Cloudflare Dashboard (если wrangler ругается):
--    dash.cloudflare.com → Storage & Databases → D1 → coldline →
--    вкладка Console → вставить ВЕСЬ текст ниже → Execute.

CREATE TABLE IF NOT EXISTS issuer_affiliations (
  child_inn   TEXT NOT NULL,
  parent_inn  TEXT,
  parent_name TEXT,
  share_pct   REAL,
  role        TEXT NOT NULL,
  parent_kind TEXT,
  source      TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (child_inn, parent_inn, role)
);

CREATE INDEX IF NOT EXISTS idx_aff_parent ON issuer_affiliations(parent_inn);
CREATE INDEX IF NOT EXISTS idx_aff_child  ON issuer_affiliations(child_inn);
CREATE INDEX IF NOT EXISTS idx_aff_role   ON issuer_affiliations(role);
