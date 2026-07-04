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
| `rsi_w` | — (Python rsi() = Уайлдер) | = _chartCalcRSI, текст врёт «SMMA» | стратегия (там настоящий Уайлдер) | 🔲 2.2 ⚖️ порт Уайлдера |
| `wr` | — | osc-дивердженс общий | — | 🔲 реестр Ч.3 |
| `cci` | — | osc общий; знаменатель нестабилен на p<10 | — | 🔲 2.6 |
| `mfi` | — | volume-override; не смотрит ликвидность | — | 🔲 2.7 |
| `stoch` | — | osc; %D заморожен | — | 🔲 2.9 |
| `cmo` | — | osc общий | — | ⏭️ Ч.3 |
| `tsi` | — | osc; smooth=13 заморожен от len | — | 🔲 2.11 |
| `ult_osc` | — | osc; 3 периода — какой адаптировать? | — | ⏭️ Ч.3 |

## Тренд / импульс

| indlab id | стратегия | альт сейчас | лучше где | статус |
|---|---|---|---|---|
| `fisher` | FISHER_RSI (Ehlers core: триггер-линия+z+цена) | trend streak-fade | **стратегия** (блок 3) | 🔲 2.3 ⚖️ порт Ehlers-ядра |
| `macd` | — | trend streak-fade; 3 компонента | — | 🔲 Ч.3 (линия/гистограмма/сигнал?) |
| `ao` | — | trend | — | ⏭️ Ч.3 |
| `ema` | ZLEMA_SIGNAL/T3_SIGNAL (варианты) | trend | — | ⏭️ Ч.3 |
| `adx` | — | trend; не использует +DI/−DI | — | 🔲 2.5 (сходимость DI + сетка≥14) |
| `parabolic` | — | trend; свой параметр AF, не период | — | 🔲 Ч.3 |
| `supertrend` | — | trend; ATR-множитель важнее периода | — | 🔲 2.10 |

## Канал / волатильность

| indlab id | стратегия | альт сейчас | лучше где | статус |
|---|---|---|---|---|
| `bb` | BB_KELTNER_SQUEEZE | channel band-walk; множитель заморожен | — | 🔲 2.8 (2D перебор) |
| `keltner` | (в BB_KELTNER_SQUEEZE) | channel; ATR-множитель как SuperTrend | — | 🔲 Ч.3 |
| `envelopes` | MA_ENVELOPE | channel | — | ⏭️ Ч.3 |
| `donchian` | DONCHIAN | channel | — | ⏭️ Ч.3 |
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
3. 🔲 2.2 RSI Wilder — порт настоящего Уайлдера из стратегии
4. 🔲 2.3 Fisher — порт Ehlers-ядра из стратегии
5. 🔲 2.5 ADX — +DI/−DI сходимость
6. 🔲 2.8–2.11 — правильный рычаг (BB множитель, Stoch %D, SuperTrend ATR, TSI smooth)
7. 🔲 2.6 CCI, 2.7 MFI, 2.4 TMF, 2.12 фильтры, 2.13 CUSUM
8. 🔲 Реестр Ч.3 — по группам
