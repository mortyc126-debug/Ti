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
    regime_confidence REAL DEFAULT 1.0,       -- понижается при свежем изломе тренда (BOCD)
    method_weights  TEXT,                     -- JSON {method_name: ewa_weight}, NULL если не считалось
    updated_at      TEXT NOT NULL,            -- ISO timestamp записи
    PRIMARY KEY (ticker, date)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_ticker ON snapshots(ticker);
CREATE INDEX IF NOT EXISTS idx_snapshots_date ON snapshots(date);

-- Per-trade attribution: какой метод был прав, в каком режиме, с каким
-- качеством. Делится между всеми инстансами бота — method_performance
-- можно считать по сделкам ВСЕХ, а не только своего процесса.
CREATE TABLE IF NOT EXISTS trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker          TEXT NOT NULL,
    date            TEXT NOT NULL,            -- YYYY-MM-DD (UTC), дата закрытия
    dir             TEXT NOT NULL,            -- LONG | SHORT
    entry           REAL NOT NULL,
    exit            REAL NOT NULL,
    mfe             REAL NOT NULL,            -- доля от entry
    mae             REAL NOT NULL,            -- доля от entry
    quality         REAL NOT NULL,            -- mfe / (mfe + mae + eps)
    method_scores   TEXT NOT NULL,            -- JSON {method_name: score на момент входа}
    regime          TEXT,
    tf_regimes      TEXT,                     -- JSON {"1min":.., "5min":.., "1h":..}
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trades_ticker_date ON trades(ticker, date);

-- Архив исторических 5-минутных свечей по тикеру — чтобы дашборд при
-- бэктесте не тянул одни и те же дни у Tinkoff API повторно при каждом
-- прогоне с другими параметрами take/stop, и чтобы можно было накопить
-- архив глубже, чем держит сам Tinkoff (свечи копятся day-by-day из тех
-- запросов, что уже были сделаны хоть раз).
CREATE TABLE IF NOT EXISTS candles (
    ticker  TEXT NOT NULL,
    time    TEXT NOT NULL,             -- ISO timestamp свечи (UTC)
    open    REAL NOT NULL,
    high    REAL NOT NULL,
    low     REAL NOT NULL,
    close   REAL NOT NULL,
    volume  INTEGER NOT NULL,
    PRIMARY KEY (ticker, time)
);

CREATE INDEX IF NOT EXISTS idx_candles_ticker_time ON candles(ticker, time);
