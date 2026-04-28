# TRACK E — Стресс-индекс эмитента и когортный анализ

## Цель

Построить **композитный стресс-индекс** (0..100) для каждого эмитента,
обновляемый ежедневно. Индекс синтезирует поведение цен/объёмов/спредов
бумаг + макро + события + фундаментал.

Параллельно — **когортные сравнения**: для эмитента X найти 10 похожих
по отрасли / долговой нагрузке / размеру / типу выпусков, посчитать,
как когорта реагировала на сходные стрессы в прошлом. Это даёт
пользователю контекст «что обычно бывает с такими в такой ситуации».

## Зависимости

- TRACK B (макро) — для нормировки на «общую обстановку».
- TRACK C (события) — для bonus-стресса при свежих негативных событиях.
- TRACK D (рейтинги) — для коридора «ожидаемого» стресса по рейтингу.
- Существующие `bond_daily`, `stock_daily`, `issuer_reports` — основа.

## Композитный стресс-индекс (formula)

```
stress = w1*price_drop + w2*volume_spike + w3*yield_spread +
         w4*volatility + w5*event_pressure + w6*leverage_overhead

price_drop      = z-score(closing_price, last 30 days, inverted)
volume_spike    = z-score(daily_volume, last 30 days)
yield_spread    = (bond.yield - matching_OFZ.yield) — превышение спреда
                  над когортой
volatility      = stddev(returns_5d) / mean(returns_5d)
event_pressure  = sum(severity_weight) for events in last 14 days
                  (critical=10, high=5, medium=2, low=0.5)
leverage_overhead = (debt/EBITDA - cohort_median) / cohort_p75
```

Веса w1..w6 — стартово равные (1/6), tunable через query
`?weights=p:2,v:1,...`. Все компоненты нормированы на 0..100,
clamp'ятся на 0/100.

## Схема D1

```sql
-- Дневной снапшот стресс-индекса по эмитенту
CREATE TABLE IF NOT EXISTS stress_signals (
  inn               TEXT NOT NULL,
  date              TEXT NOT NULL,
  stress_total      REAL NOT NULL,        -- 0..100
  comp_price_drop   REAL,
  comp_volume_spike REAL,
  comp_yield_spread REAL,
  comp_volatility   REAL,
  comp_event_pres   REAL,
  comp_leverage     REAL,
  cohort_key        TEXT,                 -- 'oil-gas:2:M' (sector:leverage:size)
  cohort_p25        REAL,                 -- стресс p25 в когорте
  cohort_p50        REAL,
  cohort_p75        REAL,
  computed_at       TEXT NOT NULL,
  PRIMARY KEY (inn, date)
);
CREATE INDEX IF NOT EXISTS idx_stress_inn ON stress_signals(inn);
CREATE INDEX IF NOT EXISTS idx_stress_date ON stress_signals(date);
CREATE INDEX IF NOT EXISTS idx_stress_total ON stress_signals(stress_total);
CREATE INDEX IF NOT EXISTS idx_stress_cohort ON stress_signals(cohort_key);

-- Денормализованные фичи эмитента — обновляется при изменении reports/affiliations
CREATE TABLE IF NOT EXISTS issuer_features (
  inn                 TEXT PRIMARY KEY,
  sector              TEXT,
  leverage_bucket     TEXT,               -- 'low' (<2x) | 'mid' (2-4) | 'high' (4-6) | 'risk' (>6)
  size_bucket         TEXT,               -- 'micro' (<1bn) | 'small' (1-10) | 'mid' (10-100) | 'large' (>100)
  ebitda_marg         REAL,
  net_debt_eq         REAL,
  current_ratio       REAL,
  bonds_count         INTEGER,
  has_stock           INTEGER,            -- 0/1
  rating_score        INTEGER,            -- 0..21 (см. TRACK D)
  cohort_key          TEXT,               -- composite ключ
  features_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_features_cohort ON issuer_features(cohort_key);

-- Корреляции между парами цен (для lead-lag, синхронности)
CREATE TABLE IF NOT EXISTS price_correlations (
  secid_a    TEXT NOT NULL,
  secid_b    TEXT NOT NULL,
  window_days INTEGER NOT NULL,           -- 30 | 90 | 365
  corr       REAL,
  lag_days   INTEGER,                     -- сдвиг при максимальной корр-ции
  computed_at TEXT NOT NULL,
  PRIMARY KEY (secid_a, secid_b, window_days)
);
```

## Endpoints

- `POST /compute/stress?date=today&limit=500` — пересчёт стресс-индекса.
  Идёт по issuers с `kind='corporate'`, для каждого считает 6 компонент,
  пишет `stress_signals`.
- `POST /compute/features` — обновляет `issuer_features` по reports +
  bond_daily + ratings.
- `POST /compute/correlations?window=90` — пересчёт корреляций для
  топ-100 ликвидных бумаг.
- `GET /issuer/{inn}/stress` — текущий стресс + 30-дневный график.
- `GET /issuer/{inn}/peers?k=10` — k ближайших по features.
- `GET /cohort/{key}/distribution?metric=stress_total` — гистограмма
  стресса в когорте.
- `GET /stress/leaderboard?dir=top` — топ-20 самых стрессовых эмитентов.

## k-NN похожих эмитентов

Простой подход (без векторных БД):

```js
function similarity(a, b){
  let score = 0;
  if(a.sector === b.sector) score += 30;
  if(a.leverage_bucket === b.leverage_bucket) score += 20;
  if(a.size_bucket === b.size_bucket) score += 15;
  if(a.has_stock === b.has_stock) score += 5;
  // числовые: близость по ROA, EBITDA marg
  if(a.ebitda_marg && b.ebitda_marg)
    score += 10 * Math.exp(-Math.abs(a.ebitda_marg - b.ebitda_marg) / 10);
  if(a.net_debt_eq && b.net_debt_eq)
    score += 10 * Math.exp(-Math.abs(a.net_debt_eq - b.net_debt_eq));
  // рейтинг
  if(a.rating_score && b.rating_score)
    score += 10 * Math.exp(-Math.abs(a.rating_score - b.rating_score) / 3);
  return score;
}
```

Для каждого эмитента можно за O(N) сравнить со всеми (N=952, 10мс на CPU).

## Event study (на отложенный коммит, после основной работы)

Для пары (event_type, инициатор) построить «средний график цены/объёма
±30 дней». Хранить в `event_study_cache` (key = type+sector). Endpoint
`/cohort/{key}/event_study?type=rating_downgrade`.

## Acceptance criteria

- [ ] `/compute/stress` за один прогон обрабатывает 100+ эмитентов
  и пишет в `stress_signals`.
- [ ] `GET /issuer/2460066195/stress` (РусГидро) возвращает число 0..100
  + разбивку по компонентам.
- [ ] `GET /issuer/{inn}/peers?k=10` для эмитента в `oil-gas` возвращает
  10 имён, преимущественно из той же отрасли.
- [ ] В `/status`: `stress_signals_today`, `features_built_at`.

## Что не делать

- Не делать ML-модель — простой композит работает и интерпретируем.
- Не пересчитывать корреляции каждый день для всех пар (5000² = 25M).
  Только топ-100 ликвидных, раз в неделю.
- Не делать прогноз цены — мы оцениваем стресс, не предсказываем
  направление.
