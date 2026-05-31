-- Миграция 1.0.1 — Telegram Bot алерты
-- Применить: npx wrangler d1 execute bondan-db --file=backend/migrations/1.0.1_telegram.sql

CREATE TABLE IF NOT EXISTS tg_subscribers (
  chat_id     TEXT PRIMARY KEY,
  username    TEXT,
  first_name  TEXT,
  joined_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tg_alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     TEXT NOT NULL,
  secid       TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK(kind IN (
                'price_above','price_below',
                'yield_above','yield_below',
                'basis_above','basis_below'
              )),
  threshold   REAL NOT NULL,
  note        TEXT,
  last_sent   TEXT,
  cooldown_h  INTEGER NOT NULL DEFAULT 24,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  active      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_tg_alerts_chat   ON tg_alerts(chat_id);
CREATE INDEX IF NOT EXISTS idx_tg_alerts_secid  ON tg_alerts(secid);
CREATE INDEX IF NOT EXISTS idx_tg_alerts_active ON tg_alerts(active, last_sent);
