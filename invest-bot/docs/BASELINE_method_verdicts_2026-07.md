# BASELINE вердиктов методов — score_methods --by-regime, июль 2026

Чистый снимок прогона `score_methods.py ALL --by-regime` (полный пул ~415
тикеров). **Точка отсчёта:** с ней сравниваем будущие варианты, когда будем
комбинировать toggle/веса. Здесь — «как есть» на сыром edge методов (d,
Cohen's), ДО применения инверсий/выключений в боте.

Применённый набор лежит в `data/method_toggle_state.json`.

> **Обновление 27.07.2026:** BASELINE пересчитан + провалидирован через
> `oos_diff.py` и `walk_forward.py` (12 окон × 90 дней) на топ-50 ликвидных.
> Результат: **33 stable / 20 drift / 1 noise** (walk-forward подтверждает
> подавляющее большинство вердиктов). Единственный noise — `ELLIOTT_WAVE`,
> перенесён в `disabled`. В `inverted` докинуто 6 stable-anti методов, не
> покрытых первичным BASELINE. Итого сейчас: **9 disabled + 16 inverted**.
> Подробности — в разделе «Обновление 27.07.2026» ниже. Ссылка на сырые
> данные: `data/analysis/walk_fw/walk_fw.txt`, `data/analysis/oos/diff.txt`,
> `docs/baseline_matrix_full.txt`, `docs/baseline_vs_top50_diff.txt`.

> Если гонялся с `--out data/analysis/scores_by_regime.csv` — держи и CSV:
> там сырые d/n_fires/n_wins по каждой паре (метод × режим), это самый
> точный материал для диффа. Этот файл — интерпретация поверх него.

---

## Три ведра (по ALL-разрезу, все режимы)

**Универсал SIGNAL (4) — работают правильно везде, не трогать:**
`FVG, HAWKES_SIGNAL, TALIB_ANTISIGNAL, ZSCORE`

**Универсал ANTI (11) — стабильно наоборот, глобально инвертировать:**
`ADAPTIVE_MA, ALLIGATOR, BB_KELTNER_SQUEEZE, BS_PRESSURE, EHLERS_MODE,
FRACTIONAL_DIFF, LEVEL_ABSORPTION, MAMA_FAMA, T3_SIGNAL, VOL_COMPRESSION,
ZLEMA_SIGNAL`
→ применено в `inverted`. Связная история: большинство — трендовые
скользящие (ADAPTIVE_MA/ALLIGATOR/MAMA_FAMA/T3/ZLEMA/EHLERS), на 5-мин
работают как fade — то же, что свечные fade-паттерны и NW-память.

**Шум (7) — нет edge ни в одном режиме, выключить:**
`DONCHIAN, KLINGER, LEVEL_QUALITY, MA_TENSION, RMI, TWIGGS, WICK_REJECTION`
→ применено в `disabled`.

**Режимные (6) — знак разный по режимам, глобально НЕ инвертировать
(только через REGIME_WEIGHT_MODS):**

| метод | up | down | ranging | high_vol | low_vol | stress |
|---|---|---|---|---|---|---|
| FALSE_BREAKOUT | + | − | + | | · | − |
| ICHIMOKU_SIGNAL | + | − | · | − | − | − |
| NADARAYA_WATSON | + | − | + | + | + | + |
| PRICE_TREND | | | + | | − | − |
| VSA | · | · | · | + | · | − |
| VSA_ABSORPTION | − | − | + | | + | − |

(`+` signal, `−` anti, `·` нейтраль, пусто — мало данных)

---

## REGIME_WEIGHT_MODS_AUTO (сгенерировано прогоном)

Полный per-regime набор (+1.0 оставить/усилить, −1.0 инвертировать). НЕ
применён в бот — кандидат на следующий шаг ПОСЛЕ теста toggle_state.

```python
REGIME_WEIGHT_MODS_AUTO = {
    "trending_up": {
        "CASCADE": +1.0, "FALSE_BREAKOUT": +1.0, "FVG": +1.0, "HAWKES_SIGNAL": +1.0,
        "ICHIMOKU_SIGNAL": +1.0, "NADARAYA_WATSON": +1.0, "RSI_DIVERGENCE": +1.0,
        "TALIB_ANTISIGNAL": +1.0, "ULT_OSC_DISAGREEMENT": +1.0, "ZSCORE": +1.0,
        "ADAPTIVE_MA": -1.0, "ALLIGATOR": -1.0, "AMT_POC": -1.0, "BB_KELTNER_SQUEEZE": -1.0,
        "BS_PRESSURE": -1.0, "EHLERS_MODE": -1.0, "FRACTIONAL_DIFF": -1.0, "LEVEL_ABSORPTION": -1.0,
        "LIQUIDITY_SWEEP": -1.0, "MAMA_FAMA": -1.0, "PRICE_ACCEL": -1.0, "T3_SIGNAL": -1.0,
        "TRIANGLE": -1.0, "VOL_COMPRESSION": -1.0, "VSA_ABSORPTION": -1.0, "VWAP_SIGNAL": -1.0,
        "ZLEMA_SIGNAL": -1.0,
    },
    "trending_down": {
        "FVG": +1.0, "HAWKES_SIGNAL": +1.0, "ORDER_BLOCK": +1.0, "RSI_DIVERGENCE": +1.0,
        "TALIB_ANTISIGNAL": +1.0, "ULT_OSC_DISAGREEMENT": +1.0, "ZSCORE": +1.0,
        "ADAPTIVE_MA": -1.0, "ALLIGATOR": -1.0, "BB_KELTNER_SQUEEZE": -1.0, "BS_PRESSURE": -1.0,
        "CANDLE_PATTERN": -1.0, "EHLERS_MODE": -1.0, "FALSE_BREAKOUT": -1.0, "FRACTIONAL_DIFF": -1.0,
        "ICHIMOKU_SIGNAL": -1.0, "LEVEL_ABSORPTION": -1.0, "LIQUIDITY_SWEEP": -1.0, "MAMA_FAMA": -1.0,
        "NADARAYA_WATSON": -1.0, "PRICE_ACCEL": -1.0, "T3_SIGNAL": -1.0, "VOL_COMPRESSION": -1.0,
        "VSA_ABSORPTION": -1.0, "VWAP_SIGNAL": -1.0, "ZLEMA_SIGNAL": -1.0,
    },
    "ranging": {
        "CASCADE": +1.0, "FALSE_BREAKOUT": +1.0, "FVG": +1.0, "HAWKES_SIGNAL": +1.0,
        "NADARAYA_WATSON": +1.0, "ORDER_BLOCK": +1.0, "PRICE_TREND": +1.0, "TALIB_ANTISIGNAL": +1.0,
        "VSA_ABSORPTION": +1.0, "ZSCORE": +1.0,
        "ADAPTIVE_MA": -1.0, "ALLIGATOR": -1.0, "BB_KELTNER_SQUEEZE": -1.0, "BS_PRESSURE": -1.0,
        "CANDLE_PATTERN": -1.0, "EHLERS_MODE": -1.0, "FRACTIONAL_DIFF": -1.0, "IMPULSE_PULLBACK": -1.0,
        "LEVEL_ABSORPTION": -1.0, "MAMA_FAMA": -1.0, "PRICE_ACCEL": -1.0, "T3_SIGNAL": -1.0,
        "VOL_COMPRESSION": -1.0, "ZLEMA_SIGNAL": -1.0,
    },
    "high_vol": {
        "ATR_EXHAUSTION": +1.0, "CASCADE": +1.0, "FVG": +1.0, "HAWKES_SIGNAL": +1.0,
        "MA_ENVELOPE": +1.0, "NADARAYA_WATSON": +1.0, "ORDER_BLOCK": +1.0, "RSI_DIVERGENCE": +1.0,
        "TALIB_ANTISIGNAL": +1.0, "ULT_OSC_DISAGREEMENT": +1.0, "VSA": +1.0, "WANING_IMPULSES": +1.0,
        "ZSCORE": +1.0,
        "ADAPTIVE_MA": -1.0, "ALLIGATOR": -1.0, "AMT_POC": -1.0, "BB_KELTNER_SQUEEZE": -1.0,
        "BS_PRESSURE": -1.0, "CUMUL_DELTA": -1.0, "CYBER_PHASE": -1.0, "EHLERS_MODE": -1.0,
        "ENTROPY": -1.0, "FRACTIONAL_DIFF": -1.0, "ICHIMOKU_SIGNAL": -1.0, "IMPULSE_PULLBACK": -1.0,
        "LEVEL_ABSORPTION": -1.0, "LIQUIDITY_SWEEP": -1.0, "MAMA_FAMA": -1.0, "SINEWAVE_SIGNAL": -1.0,
        "T3_SIGNAL": -1.0, "VWAP_SIGNAL": -1.0, "ZLEMA_SIGNAL": -1.0,
    },
    "low_vol": {
        "CASCADE": +1.0, "FVG": +1.0, "HAWKES_SIGNAL": +1.0, "MA_ENVELOPE": +1.0,
        "NADARAYA_WATSON": +1.0, "ORDER_BLOCK": +1.0, "RSI_DIVERGENCE": +1.0, "TALIB_ANTISIGNAL": +1.0,
        "VSA_ABSORPTION": +1.0, "WANING_IMPULSES": +1.0, "ZSCORE": +1.0,
        "ADAPTIVE_MA": -1.0, "ADX_DI_CONVERGENCE": -1.0, "ALLIGATOR": -1.0, "AMT_POC": -1.0,
        "BB_KELTNER_SQUEEZE": -1.0, "BS_PRESSURE": -1.0, "CANDLE_PATTERN": -1.0, "CYBER_PHASE": -1.0,
        "EHLERS_MODE": -1.0, "FRACTIONAL_DIFF": -1.0, "ICHIMOKU_SIGNAL": -1.0, "LEVEL_ABSORPTION": -1.0,
        "LIQUIDITY_SWEEP": -1.0, "MAMA_FAMA": -1.0, "PRICE_ACCEL": -1.0, "PRICE_TREND": -1.0,
        "T3_SIGNAL": -1.0, "VOL_COMPRESSION": -1.0, "VWAP_SIGNAL": -1.0, "ZLEMA_SIGNAL": -1.0,
    },
    "stress": {
        "CASCADE": +1.0, "FVG": +1.0, "HAWKES_SIGNAL": +1.0, "NADARAYA_WATSON": +1.0,
        "ORDER_BLOCK": +1.0, "RSI_DIVERGENCE": +1.0, "TALIB_ANTISIGNAL": +1.0,
        "ULT_OSC_DISAGREEMENT": +1.0, "WANING_IMPULSES": +1.0, "ZSCORE": +1.0,
        "ADAPTIVE_MA": -1.0, "ALLIGATOR": -1.0, "AMT_POC": -1.0, "BB_KELTNER_SQUEEZE": -1.0,
        "BS_PRESSURE": -1.0, "CANDLE_PATTERN": -1.0, "CUMUL_DELTA": -1.0, "EHLERS_MODE": -1.0,
        "ENTROPY": -1.0, "FALSE_BREAKOUT": -1.0, "FISHER_RSI": -1.0, "FRACTIONAL_DIFF": -1.0,
        "ICHIMOKU_SIGNAL": -1.0, "IMPULSE_PULLBACK": -1.0, "LEVEL_ABSORPTION": -1.0, "LIQUIDITY_SWEEP": -1.0,
        "MAMA_FAMA": -1.0, "PRICE_ACCEL": -1.0, "PRICE_TREND": -1.0, "T3_SIGNAL": -1.0,
        "VOL_COMPRESSION": -1.0, "VOL_MOMENTUM": -1.0, "VSA": -1.0, "VSA_ABSORPTION": -1.0,
        "VWAP_SIGNAL": -1.0, "VZO": -1.0, "ZLEMA_SIGNAL": -1.0,
    },
}
```

---

## Зависимость edge (d) от ликвидности/волатильности тикера

Кросс-подтверждение NW-памяти: **направленный edge концентрируется на менее
ликвидных тикерах.** Все SIGNAL-методы имеют отрицательный `sp_liq` (сильнее
на неликвиде). Spearman: `+` сильнее на ликвидных, `−` на неликвидных;
`d_lo`/`d_hi` — медиана d в нижней/верхней трети по ликвидности.

| метод | n_tk | sp_liq | sp_vol | d_lo | d_hi | флаг |
|---|---|---|---|---|---|---|
| VWAP_SIGNAL | 408 | +0.21 | +0.15 | −0.109 | −0.023 | |
| IMPULSE_PULLBACK | 405 | +0.19 | +0.03 | −0.091 | −0.022 | |
| CASCADE | 358 | −0.19 | −0.19 | +0.257 | +0.082 | |
| FRACTIONAL_DIFF | 401 | +0.18 | +0.19 | −0.099 | −0.048 | |
| FVG | 410 | −0.16 | −0.16 | +0.099 | +0.053 | |
| PRICE_TREND | 64 | +0.16 | −0.04 | −0.567 | −0.420 | малый n |
| TALIB_ANTISIGNAL | 392 | −0.15 | −0.19 | +0.235 | +0.112 | |
| BB_KELTNER_SQUEEZE | 410 | +0.15 | +0.14 | −0.090 | −0.060 | |
| AMT_POC | 375 | +0.14 | +0.16 | −0.069 | −0.026 | |
| BS_PRESSURE | 26 | −0.14 | −0.10 | −0.150 | −0.230 | малый n |
| T3_SIGNAL | 403 | +0.13 | +0.17 | −0.191 | −0.118 | |
| MA_TENSION | 18 | +0.13 | −0.15 | +1.023 | +1.756 | малый n |
| VSA | 395 | +0.12 | +0.14 | −0.038 | +0.000 | знак-флип |
| ZLEMA_SIGNAL | 399 | +0.12 | +0.16 | −0.195 | −0.103 | |
| NADARAYA_WATSON | 371 | −0.12 | −0.22 | +0.121 | +0.050 | |
| ZSCORE | 392 | −0.10 | −0.12 | +0.139 | +0.089 | |
| HAWKES_SIGNAL | 415 | −0.10 | −0.14 | +0.078 | +0.049 | |
| WANING_IMPULSES | 385 | −0.11 | −0.09 | +0.070 | +0.040 | |
| ORDER_BLOCK | 361 | −0.07 | −0.07 | +0.094 | +0.076 | |

(полный список из 50 методов — в консольном выхлопе/CSV; тут сильнейшие)

**Вывод:** сигнальные методы (CASCADE, TALIB, FVG, NADARAYA, ZSCORE, HAWKES,
ORDER_BLOCK, WANING) — `sp_liq < 0`, edge в 2-3× сильнее на неликвиде.
Анти/шум — в основном `sp_liq > 0` (слабее анти на ликвиде). Это тот же
градиент, что у NW-памяти → ликвидностный гейт/down-weight на топ-ликвидах —
общая тема, не частность одного метода.

---

## Как пользоваться при комбинировании

1. Прогнал вариант (другой toggle/веса/пороги) → сравни с этим baseline:
   какие методы сменили ведро, куда уехал d, изменился ли ликвид-градиент.
2. Метрику бота (WR/expectancy) варианта сравнивай с baseline-прогоном бота
   ДО применения toggle_state — иначе не с чем.
3. Обновляешь метод/добавляешь новый → перегони score_methods, обнови этот
   файл (или заведи `_2026-08` рядом), старый оставь для истории.

---

## Обновление 27.07.2026 — валидация walk_forward + top-50

**Что сделано:** повторный прогон `score_methods.py --top-liq 50 --by-regime`
(на топ-50 ликвидных с фильтром vol) + два новых валидационных скрипта:
`oos_diff.py` (train 365 дн vs test 120 дн на одном универсе) и
`walk_forward.py` (12 непересекающихся 90-дневных окон подряд, сначала —
свежее). Цель: понять, случайны ли вердикты BASELINE или воспроизводятся
на новых данных.

### walk_forward: 33 stable / 20 drift / 1 noise

**Правило классификации:** знак d одинаковый в ≥75% окон И (при том же
знаке) std(d) < mean(|d|)/2 → **stable**. Знак один, но std большой →
**drift**. Знак пляшет между + и − → **noise**.

- **stable (33 методов, 62%)** — знак и сила воспроизводимы во всех окнах.
  Сюда попали все ключевые из BASELINE: `AMIHUD_SHOCK +0.12..+0.44`,
  `DFA_REGIME +0.14..+0.34`, `ZSCORE +0.06..+0.31`, `TALIB_ANTISIGNAL
  +0.07..+0.27`, `BIPOWER_JUMP +0.07..+0.44`, `HAWKES_SIGNAL +0.03..+0.16`,
  `FVG +0.06..+0.13`, `CASCADE +0.02..+0.23`, `ORDER_BLOCK +0.05..+0.15`,
  `WANING_IMPULSES +0.02..+0.12` (signal); + `ADAPTIVE_MA -0.07..-0.30`,
  `BB_KELTNER_SQUEEZE -0.07..-0.19`, `ANCHORED_VWAP -0.07..-0.24`,
  `ALLIGATOR_CLASSIC -0.07..-0.24`, `T3_CLASSIC -0.06..-0.22`,
  `PRICE_ACCEL -0.05..-0.11` (anti). Полный список — в
  `data/analysis/walk_fw/walk_fw.txt`.
- **drift (20 методов, 37%)** — знак стабильный, сила гуляет. Эдж есть, но
  ставить фиксированный вес нельзя. Сюда: `NADARAYA_WATSON` (positive в 10
  из 12 окон), `RSI_DIVERGENCE`, `T3_SIGNAL`, `KLINGER`, `DONCHIAN`,
  `TWIGGS`, `ATR_EXHAUSTION` и др. Для этих правильно — режимные MODS
  (см. AUTO ниже), но НЕ глобальная инверсия.
- **noise (1 метод, 1.8%)** — только `ELLIOTT_WAVE`. Знак пляшет:
  `+0.15/+0.13/-0.24/-0.16/+0.02/-0.66/…`, куча пропусков. Инверсия не
  спасает — метод случайный. **Отключён.**

### Изменения в `data/method_toggle_state.json`

**`disabled`: 8 → 9.** Добавлен `ELLIOTT_WAVE` (noise по walk_forward).
Актуальный список: `ALLIGATOR, DONCHIAN, ELLIOTT_WAVE, KLINGER,
LEVEL_QUALITY, MA_TENSION, RMI, TWIGGS, WICK_REJECTION`.

**`inverted`: 11 → 16.** Убран `ELLIOTT_WAVE` (теперь в disabled).
Добавлено 6 stable-anti из walk_forward + top-50 (в первичном BASELINE
их не было — либо `_CLASSIC`-версии добавлены позже, либо не были в
топе):

| метод | walk-fw диапазон d | комментарий |
|---|---|---|
| `ADAPTIVE_MA_CLASSIC` | −0.06..−0.22 | stable anti во всех 12 окнах |
| `ALLIGATOR_CLASSIC` | −0.07..−0.24 | stable anti; +top-50 универсал ANTI |
| `CUMUL_DELTA` | −0.02..−0.10 | stable anti; в первичном BASELINE был noise (-0.045) |
| `MA_TENSION_CLASSIC` | −0.03..−0.15 | stable anti в 6/6 режимов top-50 |
| `T3_CLASSIC` | −0.06..−0.22 | stable anti; аналогично `T3_SIGNAL` |
| `ZLEMA_CLASSIC` | −0.05..−0.18 | stable anti; +top-50 |

Актуальный `inverted`: `ADAPTIVE_MA, ADAPTIVE_MA_CLASSIC, ALLIGATOR_CLASSIC,
BB_KELTNER_SQUEEZE, BS_PRESSURE, CUMUL_DELTA, EHLERS_MODE, FRACTIONAL_DIFF,
LEVEL_ABSORPTION, MAMA_FAMA, MA_TENSION_CLASSIC, T3_CLASSIC, T3_SIGNAL,
VOL_COMPRESSION, ZLEMA_CLASSIC, ZLEMA_SIGNAL`.

### OOS-дифф train vs test (365 дн / 120 дн)

Из 256 сопоставимых клеток (метод × режим, обе стороны с n_tk ≥ 5):
- **aligned: 175 (68%)** — знак и сила близки → надёжный эдж.
- **stronger: 28 (11%)** — тот же знак, в test даже сильнее.
- **weaker: 35 (14%)** — тот же знак, ослаб.
- **DIVERGE: 10 (4%)** — знак сохранён, но \|Δd\| > 0.10.
- **★FLIP★: 8 (3%)** — знак поменялся. Все 8 на клетках с n_tk 6-11
  (граничная статистика). Список — в `data/analysis/oos/diff.txt`.

Вывод: FLIP-доля 3% ≤ 5% → **BASELINE в целом воспроизводим**, MODS_AUTO
можно применять с оговоркой не тащить конкретные FLIP-клетки в бота.

### top-50 подтверждает и расширяет универсал ANTI

Свежий прогон на топ-50 ликвидных с фильтром `n_tk ≥ 5` даёт **9
универсал ANTI** методов (было 4 в первичном top-50, 11 в BASELINE, но с
`_CLASSIC`-версиями):

`ADAPTIVE_MA_CLASSIC, ALLIGATOR, ALLIGATOR_CLASSIC, ANCHORED_VWAP,
BB_KELTNER_SQUEEZE, CUMUL_DELTA, MA_TENSION_CLASSIC, T3_CLASSIC,
T3_SIGNAL`.

Все 9 либо уже были в `inverted`, либо теперь добавлены (см. таблицу выше).

### Что применено в расширении tv-signals-extension

Расширение уже использует MODS-логику клиентски (`signals-core.js`):
`accel, liq_sweep` глобально инвертированы (bейдж ↺anti), `nw` режимно
инвертирован в trending_down (⚙REG-INV), `elliott_wave` отключён
(бейдж `off`). Первая версия — коммит 253b5b8 (accel/liq_sweep/nw),
докинуто в 4e093bd (elliott_wave → off).

### Что не сделано (задел на будущее)

1. **`REGIME_WEIGHT_MODS_AUTO` из свежего прогона** — в текущем виде AUTO
   грубый (±1.0 vs плавные 0.3-1.6 в ручном `regime.py:REGIME_WEIGHT_MODS`).
   Правильный путь — не заменять ручной MODS, а мёржить: AUTO рекомендует
   что инвертировать для методов из score_methods, ручной оставляет свои
   коэффициенты для методов бэкенд-стратегии (BS_PRESSURE_TS, OB_IMBALANCE
   и т.п., которых в score_methods нет). Отдельный ход.
2. **Двухуровневые режимы (macro × micro)** — 6-режимный классификатор
   работает на 60 барах 5м = 5 часов, ловит микрофазы. Добавить макро на
   дневных барах → пары `macro × micro`, различать «отскок в даунтренде»
   от «продолжения аптренда». Правки в `regime.py`, размножение строк
   MODS. Не срочно.
3. **Continuous-фьючерсы** — сейчас в кэше отдельные json'ы на каждый
   контракт (`SiU6, SiZ6, …`), склеенных `Si_c1` нет. Для нормальной
   валидации фьючерсов через walk_forward нужен continuous-ряд с
   panama-adjust. Отдельная работа сборщика данных.
4. **Реальный бэктест композита с новыми `inverted/disabled`** — цифры в
   заголовках («+2-3 п.п. WR») пока грубая оценка. Прогнать `dashboard.py`
   с новым toggle_state и сравнить со снимком до изменений.
