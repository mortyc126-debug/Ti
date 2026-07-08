# BASELINE вердиктов методов — score_methods --by-regime, июль 2026

Чистый снимок прогона `score_methods.py ALL --by-regime` (полный пул ~415
тикеров). **Точка отсчёта:** с ней сравниваем будущие варианты, когда будем
комбинировать toggle/веса. Здесь — «как есть» на сыром edge методов (d,
Cohen's), ДО применения инверсий/выключений в боте.

Применённый набор лежит в `data/method_toggle_state.json` и продублирован
пресетом `score_methods_pool_2026-07_refined` в `data/method_presets.json`
(откат — загрузить пустой набор или пресет прошлого прогона).

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
