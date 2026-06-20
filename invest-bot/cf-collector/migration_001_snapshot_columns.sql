-- Миграция для баз, созданных до появления regime_confidence/method_weights
-- в schema.sql (CREATE TABLE IF NOT EXISTS не добавляет колонки в уже
-- существующую таблицу). Запускать один раз.
ALTER TABLE snapshots ADD COLUMN regime_confidence REAL DEFAULT 1.0;
ALTER TABLE snapshots ADD COLUMN method_weights TEXT;
