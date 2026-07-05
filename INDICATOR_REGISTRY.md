# Реестр индикаторов: indlab ↔ стратегия (единый чек-лист)

Единый источник правды по индивидуализации альт-формул и кросс-переносу между
браузерным **indlab** (`indlab_v10 (1).html`, JS) и **живой стратегией**
(`invest-bot/trade_system/strategies/oi_composite_strategy.py`, Python).

**Принцип кросс-переноса:** где реализация в стратегии продуманнее — переносим
в indlab; где в indlab лучше — в стратегию. Где ни там ни там нет хорошей формы
— доводим до лучшего состояния (не ограничиваясь ТЗ).

**Статусы:** ✅ сделано · 🔲 todo · ⚖️ нужен кросс-перенос · 📝 только описание/ярлык · ⏭️ низкий приоритет

**Общая методология (ТЗ Часть 0):** ✅ портирована в indlab (`_ilAdaptiveSeries`,
walk-forward + значимость + горизонт=f(p) + усадка + плацебо). В стратегии —
`method_calibrator.py` (walk-forward, expectancy со стопом, per-ticker пороги).

---

## Осцилляторы / перекупленность

| indlab id | стратегия | альт сейчас | лучше где | статус |
|---|---|---|---|---|
| `rsi` | RSI_DIVERGENCE (сырой RSI, двухпик) | ✅ `_ilAltRSI` (failure swing+обрыв окна+сырой) | было: стратегия; теперь паритет | ✅ 2.1 |
| `rsi_w` | — (Python rsi() = Уайлдер) | ✅ настоящий Уайлдер (SMMA), нет обрыва окна | ⚖️ порт из стратегии сделан | ✅ 2.2 |
| `wr` | — | osc-дивердженс общий | — | 🔲 реестр Ч.3 |
| `cci` | — | ✅ сетка≥10 + `_ilAltCCI` (гасит экстремум при нестабильном знаменателе) | — | ✅ 2.6 |
| `mfi` | — | ✅ структурный гейт вырожденного объёма перед подбором | новое (не магич. порог) | ✅ 2.7 |
| `stoch` | — | ✅ 2D перебор %K×%D | — | ✅ 2.9 |
| `cmo` | — | osc общий | — | ⏭️ Ч.3 |
| `tsi` | — | ✅ smooth=f(len)≈len/2 | — | ✅ 2.11 |
| `ult_osc` | — | osc; 3 периода — какой адаптировать? | — | ⏭️ Ч.3 |

## Тренд / импульс

| indlab id | стратегия | альт сейчас | лучше где | статус |
|---|---|---|---|---|
| `fisher` | FISHER_RSI (Ehlers core: триггер-линия+z+цена) | ✅ `_ilAltFisher` (триггер+z+цена) | ⚖️ порт Ehlers-ядра сделан | ✅ 2.3 |
| `macd` | — | trend streak-fade; 3 компонента | — | 🔲 Ч.3 (линия/гистограмма/сигнал?) |
| `ao` | — | trend | — | ⏭️ Ч.3 |
| `ema` | ZLEMA_SIGNAL/T3_SIGNAL (варианты) | trend | — | ⏭️ Ч.3 |
| `adx` | — | ✅ `_ilAltADX` (сходимость +DI/−DI) + сетка≥14 | новое (лучше ТЗ-описания) | ✅ 2.5 |
| `parabolic` | — | trend; свой параметр AF, не период | — | 🔲 Ч.3 |
| `supertrend` | — | ✅ адаптируется ATR-множитель (2D) | — | ✅ 2.10 |

## Канал / волатильность

| indlab id | стратегия | альт сейчас | лучше где | статус |
|---|---|---|---|---|
| `bb` | BB_KELTNER_SQUEEZE | ✅ 2D перебор + band-walk fix (Б.5: подтверждение, не разворот) | — | ✅ 2.8 |
| `keltner` | (в BB_KELTNER_SQUEEZE) | ✅ унаследовал band-walk fix (общий диспетчер channel) | — | ✅ Б.5 |
| `envelopes` | MA_ENVELOPE | ✅ унаследовал band-walk fix, отдельный разбор для % ширины todo | — | 🔲 своя формула Ч.3 |
| `donchian` | DONCHIAN | ⚠️ ВРЕМЕННО унаследовал band-walk, НО (Б.5/3.7) у Donchian `pos∈[0,100]` всегда — своя формула нужна | — | 🔲 3.7 срочно |
| `hist_vol` | — | channel | — | ⏭️ Ч.3 |
| `bb_pct` | — | dsp-override | — | ⏭️ Ч.3 |
| `bb_width` | VOL_COMPRESSION (близко) | channel | — | ⏭️ Ч.3 |

## Объём / деньги

| indlab id | стратегия | альт сейчас | лучше где | статус |
|---|---|---|---|---|
| `tmf` (Twiggs MF) | TWIGGS | dsp flip-fade; без объёма отдельно | стратегия чуть полнее | 🔲 2.4 |
| `cum_delta` | CUMUL_DELTA | dsp; встроенное сравнение с ценой | **стратегия** (модель для DSP) | 🔲 Ч.3 ⚖️ |
| `obv`,`acc_dist`,`cmf`,`force_idx`,`pvt`,`vo` | частично VZO/KLINGER | volume общий | — | ⏭️ Ч.3 (объём независим от цены?) |
| `elder_ray`,`elder_impulse` | — | volume/period-адаптация уместна | — | ⏭️ Ч.3 |

## Структура / цикл

| indlab id | стратегия | альт сейчас | лучше где | статус |
|---|---|---|---|---|
| `ichimoku` | ICHIMOKU_SIGNAL | structure chop-fade; 5 линий | — | ⏭️ Ч.3 (что из 5 управляет?) |
| `alligator` | ALLIGATOR | structure | — | ⏭️ Ч.3 |
| `mama` | MAMA_FAMA | structure | — | ⏭️ Ч.3 |
| `cyber_cycle` | CYBER_PHASE/EHLERS_MODE | structure | — | ⏭️ Ч.3 |
| `ebs` | SINEWAVE_SIGNAL (even better sinewave) | structure | паритет | ⏭️ Ч.3 |
| `ssa` | SSA_SIGNAL | structure | — | ⏭️ Ч.3 |
| `zigzag`,`fractals`,`dpo`,`chop`,`vortex` | FRACTAL (fractals) | structure | — | ⏭️ Ч.3 (у каждого своё «шумно») |

## Продвинутая статистика / DSP

| indlab id | стратегия | альт сейчас | лучше где | статус |
|---|---|---|---|---|
| `nw` | NADARAYA_WATSON | dsp flip-fade | — | 🔲 2.12 (ширина ядра фикс — общий flip ок) |
| `kalman` | — | dsp flip-fade; есть gain K | — | 🔲 2.12 (использовать K) |
| `gpr` | — | dsp flip-fade; есть дисперсия | — | 🔲 2.12 (использовать неопределённость) |
| `cusum` | CHANGE_POINT (близко) | dsp; сырая шкала (не ±2) | — | 🔲 2.13 (унификация шкалы) |

## Режим рынка (без винрейта, альта нет)

| indlab id | стратегия | статус |
|---|---|---|
| `hmm`,`hurst`,`mprof`,`te`,`rough`,`frac_dim`,`efficiency_ratio`,`entropy` | ENTROPY, регрежим | 🔲 Ч.3 (решить: давать фолбэк-альт или честно `null`) |

---

## Методы только в стратегии (в indlab нет — кандидаты на перенос туда)

SMC/ICT: **FVG, ORDER_BLOCK, LIQUIDITY_SWEEP, LEVEL_QUALITY, LEVEL_ABSORPTION,
FALSE_BREAKOUT** · VSA: **VSA, VSA_ABSORPTION, WICK_REJECTION, BS_PRESSURE** ·
Плейбуки: **CASCADE, IMPULSE_PULLBACK, WANING_IMPULSES, TRIANGLE** ·
Прочее: **RMI, ZSCORE, PRICE_TREND, TREND_QUALITY, ADAPTIVE_MA, MA_TENSION,
PRICE_ACCEL, HAWKES_SIGNAL, FRACTIONAL_DIFF, AMT_POC, ATR_EXHAUSTION,
VWAP_SIGNAL, VOL_MOMENTUM, FVG** + структурные (LEVEL_CONTEXT, MKT_STRUCTURE,
SPRING) + OI/tradestats.

→ Эти в indlab не портируем без запроса (indlab — исследование по классическим
индикаторам; SMC/VSA/плейбуки — отдельный пласт).

---

## Порядок работ

1. ✅ Часть 0 — методология (indlab + стратегия)
2. ✅ 2.1 RSI
3. ✅ 2.2 RSI Wilder — порт настоящего Уайлдера из стратегии
4. ✅ 2.3 Fisher — порт Ehlers-ядра из стратегии
5. ✅ 2.5 ADX — +DI/−DI сходимость
6. ✅ 2.8–2.11 — правильный рычаг (BB множитель, Stoch %D, SuperTrend ATR, TSI smooth) + поправка на множ. сравнения
7. 🔲 2.4 TMF, 2.12 фильтры (Kalman K/GPR дисперсия), 2.13 CUSUM  (2.6 CCI ✅, 2.7 MFI ✅)
8. 🔲 Реестр Ч.3 — по группам
