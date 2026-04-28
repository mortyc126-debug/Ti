# TRACK A — Order Book / FORTS intraday

## Цель

Собирать стакан (depth-of-market) и тиковые сделки фьючерсов с MOEX FORTS
с задержкой ~15 минут (это что есть бесплатно). По стакану считать
**baseline-метрики момента**: спред, дисбаланс заявок, агрессивность
покупателей/продавцов. Это даст пользователю понимание моментов
входа/выхода для фьючерсов, в первую очередь — на ликвидные акции
(SBER, GAZP, LKOH) и индекс RTS.

## Источник

MOEX ISS:
- `https://iss.moex.com/iss/engines/futures/markets/forts/securities/{secid}/orderbook.json` — стакан (10 уровней с обеих сторон)
- `https://iss.moex.com/iss/engines/futures/markets/forts/securities/{secid}/trades.json` — последние тиковые сделки

Лимит: пользователю интересны ~10-15 ликвидных фьючерсов. Снимать стакан
каждые 5-10 минут × 12 часов сессии × 15 фьючерсов = ~1200 снапшотов в день.
Free tier CF cron — 1 раз в минуту максимум, придётся cluster'ить запросы.

## Схема D1

```sql
-- Снапшот стакана: 1 строка = 1 снапшот = 1 секьюрити
CREATE TABLE IF NOT EXISTS orderbook_snapshots (
  secid       TEXT NOT NULL,
  ts          TEXT NOT NULL,        -- ISO timestamp
  best_bid    REAL,
  best_ask    REAL,
  spread_pct  REAL,                 -- (ask-bid)/mid × 100
  bid_volume  INTEGER,              -- сумма объёмов на 10 уровнях bid
  ask_volume  INTEGER,
  imbalance   REAL,                 -- (bid_vol - ask_vol)/(bid_vol + ask_vol)
  depth_5pct  INTEGER,              -- объём в радиусе 5% от mid
  raw_levels  TEXT,                 -- JSON: [{price, volume, side}, ...]
  PRIMARY KEY (secid, ts)
);
CREATE INDEX IF NOT EXISTS idx_ob_secid_ts ON orderbook_snapshots(secid, ts);

-- Тиковые сделки (агрегированные по 5-минуткам для экономии)
CREATE TABLE IF NOT EXISTS intraday_trades_5m (
  secid          TEXT NOT NULL,
  bucket         TEXT NOT NULL,     -- ISO timestamp начала 5-минутки
  trades_count   INTEGER,
  volume_lots    INTEGER,
  volume_rub     REAL,
  vwap           REAL,
  high           REAL,
  low            REAL,
  buy_volume     INTEGER,           -- сделки по цене ask (агрессивные покупки)
  sell_volume    INTEGER,           -- сделки по цене bid
  agg_ratio      REAL,              -- buy/(buy+sell)
  PRIMARY KEY (secid, bucket)
);
CREATE INDEX IF NOT EXISTS idx_it5_secid ON intraday_trades_5m(secid);
CREATE INDEX IF NOT EXISTS idx_it5_bucket ON intraday_trades_5m(bucket);

-- Список «горячих» фьючерсов для regular-сбора (вручную или из топ-volume)
CREATE TABLE IF NOT EXISTS orderbook_watchlist (
  secid       TEXT PRIMARY KEY,
  added_at    TEXT NOT NULL,
  enabled     INTEGER DEFAULT 1
);
```

## Endpoints (новые)

- `POST /collect/orderbook?limit=15` — собрать снапшот для каждой
  записи в `orderbook_watchlist`. cron каждые 10 минут.
- `POST /collect/orderbook/seed` — заполнить watchlist топом по
  обороту из `futures_daily`.
- `GET /futures/{secid}/orderbook?bars=20` — последние N снапшотов.
- `GET /futures/{secid}/intraday?from=...&to=...` — 5-минутки за
  указанный период.
- `GET /futures/{secid}/depth_signal` — текущий summary (spread,
  imbalance, agg_ratio за последний час) для UI «pre-trade».

## Парсер MOEX orderbook

```js
// MOEX orderbook.json возвращает {orderbook: {columns, data}}
// columns обычно: ['BOARDID','SECID','BUYSELL','PRICE','QUANTITY','SEQNUM','UPDATETIME']
function parseOrderBook(json){
  const ob = json.orderbook || {};
  const cols = ob.columns || [];
  const data = ob.data || [];
  const i = (n) => cols.indexOf(n);
  const idxSide = i('BUYSELL'), idxPrice = i('PRICE'), idxQty = i('QUANTITY');
  const bids = [], asks = [];
  for(const r of data){
    const side = r[idxSide];
    const px = r[idxPrice], qty = r[idxQty];
    if(!isFinite(px) || !isFinite(qty)) continue;
    if(side === 'B') bids.push({px, qty});
    else asks.push({px, qty});
  }
  bids.sort((a,b) => b.px - a.px);
  asks.sort((a,b) => a.px - b.px);
  const bestBid = bids[0]?.px || null;
  const bestAsk = asks[0]?.px || null;
  const mid = (bestBid && bestAsk) ? (bestBid + bestAsk)/2 : null;
  // ... считаем imbalance, depth_5pct, и т.д.
}
```

## Подсчёт agg_ratio (buy vs sell классификация)

MOEX trades.json даёт сделки с полем `BUYSELL` или с tick rule:
- `BUYSELL = 'B'` → агрессивный покупатель
- `BUYSELL = 'S'` → агрессивный продавец
- иначе — tick rule: `price > prev_price` → buy, `<` → sell

## Время и subrequest budget

- 1 секьюрити = 2 fetch'а (orderbook + trades) ≈ 0.5 сек wall-clock
- limit=15 → 30 fetch'ей, ~7 сек — укладывается в free tier
- Cron каждые 10 минут × ~70 рабочих минут × 15 fetch = ~6300/день,
  это ниже квоты CF Workers (100k/день free).

## Acceptance criteria

- [ ] При cron-запуске пишутся снапшоты в `orderbook_snapshots`.
- [ ] `GET /futures/SBER/depth_signal` отдаёт `{spread_pct, imbalance, agg_ratio_1h}`.
- [ ] За сутки накапливается ≥100 снапшотов на секьюрити из watchlist.
- [ ] В `/status` появляется `orderbook_snapshots_24h: N`.

## Что не делать

- Не ходить в реал-тайм-API (MOEX не отдаёт его публично — только
  ~15-мин задержка).
- Не считать прогноз цены — только регистрируем поведение стакана.
- Не строить графики на бэке — это задача frontend track G.
