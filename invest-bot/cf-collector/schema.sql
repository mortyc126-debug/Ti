-- D1-схема для общей базы расчётов композита по всем тикерам рынка.
-- Пишет сюда отдельный воркер сбора (collector_worker.py), читает торговый
-- бот (trader.py) перед тем, как решать, торговать ли новый тикер.
CREATE TABLE IF NOT EXISTS snapshots (
    ticker          TEXT NOT NULL,
    date            TEXT NOT NULL,            -- YYYY-MM-DD (UTC)
    composite       REAL NOT NULL,
    scores          TEXT NOT NULL,            -- JSON {method_name: score}
    regime          TEXT NOT NULL,
    rolling_quality REAL NOT NULL,
    backtest_quality REAL,                    -- NULL, если бэктест не считался
    backtest_trades  INTEGER,
    live            INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL,            -- ISO timestamp записи
    PRIMARY KEY (ticker, date)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_ticker ON snapshots(ticker);
CREATE INDEX IF NOT EXISTS idx_snapshots_date ON snapshots(date);
