# OICompositeStrategy

Многометодная торговая стратегия поверх [EIDiamond/invest-bot](https://github.com/EIDiamond/invest-bot).

## Методы анализа

| ID | Метод | Источник |
|----|-------|---------|
| PRICE_TREND | Линейная регрессия цены закрытия (N свечей) | Свечи |
| VOL_MOMENTUM | Объём × направление движения | Свечи |
| VWAP_SIGNAL | Отклонение от скользящего VWAP | Свечи |
| BS_PRESSURE | Давление тела свечи (bull/bear по размеру тела vs фитиль) | Свечи |
| CANDLE_PATTERN | Engulfing, Pin-bar, Doji | Свечи |
| ADAPTIVE_MA | Отклонение цены от KAMA (Kaufman Adaptive MA) | Свечи |
| TREND_QUALITY | TQI: знак×сила тренда (Efficiency Ratio × наклон) | Свечи |
| FRACTAL | Среднее скоров FDI/Hurst/PFE (фрактальная структура движения) | Свечи |
| ENTROPY | Перестановочная энтропия как множитель уверенности к направлению | Свечи |
| CYBER_CYCLE | Ehlers Cyber Cycle: пересечение нуля сглаженного цикла | Свечи |
| DECYCLER | Ehlers Decycler: цена минус долгосрочный low-pass тренд | Свечи |
| FISHER_RSI | Преобразование Фишера от RSI (резкие развороты) | Свечи |
| EBSW | Ehlers Even Better Sinewave: RMS-нормированный roofing filter | Свечи |
| KLINGER | Klinger Volume Oscillator: пересечение нуля | Свечи |
| VZO | Volume Zone Oscillator | Свечи |
| TWIGGS | Twiggs Money Flow | Свечи |
| RMI | Relative Momentum Index (вариант RSI на разностях) | Свечи |
| ZSCORE | Rolling z-score — контр-сигнал на возврат к среднему | Свечи |
| OI_SQUEEZE | squeeze-score из `oi_layers.py` (реальный сквиз по FutOI юр/физ) | MOEX AlgoPack |
| INST_OI | m_INST_OI: нетто-позиция юрлиц (FutOI) — "умные деньги" срочного рынка | MOEX AlgoPack |
| RETAIL_CONTRA | m_RETAIL_CONTRA: расхождение юр/физ по направлению (контр-сигнал) | MOEX AlgoPack |
| BS_PRESSURE_TS | m_BS_PRESSURE: давление покупателей/продавцов по объёму сделок | MOEX AlgoPack tradestats |
| AGGRESSOR_FLOW | m_AGGRESSOR_FLOW: объём+число сделок инициатора покупки/продажи | MOEX AlgoPack tradestats |
| LARGE_IMPACT | m_LARGE_IMPACT: перекос крупных (≥p75) сделок по стороне | MOEX AlgoPack tradestats |
| VWAP_SIGNAL_TS | Отклонение цены от внутридневного VWAP (tradestats), не свечного | MOEX AlgoPack tradestats |
| VOL_MOMENTUM_TS | Аномальный объём (по перцентилям) × направление (tradestats) | MOEX AlgoPack tradestats |
| OB_IMBALANCE | m_OB_IMBALANCE: перекос объёма в стакане у лучшей цены | MOEX AlgoPack obstats |
| CANCEL_SIGNAL | m_CANCEL_SIGNAL: перекос отмен заявок по стороне | MOEX AlgoPack orderstats |
| CHANGE_POINT | Голос направления, если ≥2 из 3 алгоритмов (CUSUM/PELT/Z-Score) нашли свежий излом | Свечи |

Режим рынка (VHF) используется как множитель надёжности, не как отдельный сигнал.
Отдельно `regime.py.classify_regime` (trending_up/trending_down/ranging/high_vol/
low_vol/stress) множит вес КАЖДОГО метода по `REGIME_WEIGHT_MODS` — например
VOL_MOMENTUM надёжнее в тренде, VWAP_SIGNAL — в боковике (порт REGIME_WEIGHT_MODS
из oi-signal-v10.html).

Все скоры ∈ [-1, 1]. Итоговый composite = взвешенная сумма × режим рынка.

OI_SQUEEZE, INST_OI и RETAIL_CONTRA подключаются `Trader`'ом через
`strategy.set_squeeze_provider(...)` / `set_inst_oi_provider(...)` /
`set_retail_contra_provider(...)` (сама стратегия не лезет в сеть) — все три
читают один и тот же FutOI-снэпшот из `oi_layers.py`, новый запрос к MOEX не
нужен. Без подключения метод просто молчит (score=0, не участвует в обучении
весов).

Семь микроструктурных методов (BS_PRESSURE_TS … CANCEL_SIGNAL) подключаются
через `strategy.set_tradestats_provider(...)` — данные идут из нового
`tradestats.py` (см. ниже), отдельного от `oi_layers.py` поллера.

## Обучение весов

Веса методов обновляются через EWA (α=0.1) после каждого закрытия сделки.  
Метрика качества — MFE/(MFE+MAE) — непрерывный [0,1] результат, не бинарный.  
Сохраняются в `oi_weights.json` рядом с `main.py`.

## Фильтры качества сигнала

Сигнал проходит дальше (к открытию позиции), только если выполнены все условия:

- **Согласие методов** — минимум 3 из 6 методов реально высказались
  (`|score| >= 0.15`) в направлении composite. Один сильный метод не может
  один протащить сигнал, пока остальные молчат или против.
- **Ликвидность** — объём последней свечи не меньше 30% медианы объёма по
  окну (защита от шума на тонком стакане).
- **Прогрев весов** — пока веса методов не набрали ~8 сделок, порог входа
  ×1.5 жёстче (доверять необученным весам рано).
- **Скользящее качество** — если последние сделки в среднем низкого
  качества (rolling quality EWA < 0.4), порог входа ×1.3 жёстче — бот сам
  "тормозит" в плохой полосе без ручного выключения.

Константы — в `trade_system/strategies/oi_composite_strategy.py`
(`MIN_AGREE_METHODS`, `LIQUIDITY_MIN_RATIO`, `WARMUP_TRADES`,
`LOW_QUALITY_THRESHOLD` и т.д.).

## Режимы

- **SIGNAL_ONLY=1** — только Telegram-уведомления, ордера не выставляются (для наблюдения/обучения)
- **SIGNAL_ONLY=0** — реальная торговля через T-Invest API

## Настройка (settings.ini)

```ini
[STRATEGY_SBER]
STRATEGY_NAME=OICompositeStrategy
TICKER=SBER
FIGI=BBG004730N88
MAX_LOTS_PER_ORDER=1

[STRATEGY_SBER_SETTINGS]
SIGNAL_THRESHOLD=0.25   # порог composite для сигнала (0–1)
LONG_TAKE=1.015         # take-profit множитель
LONG_STOP=0.985         # stop-loss множитель
SHORT_TAKE=0.985
SHORT_STOP=1.015
SIGNAL_ONLY=1           # 1 = без ордеров
```

## Запуск

```bash
pip install tinkoff-investments aiogram
python main.py
```

Заполни в `settings.ini`:
- `TOKEN` — токен T-Invest (readonly для SIGNAL_ONLY, полный для торговли;
  для sandbox — отдельный sandbox-токен, см. ниже)
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — для уведомлений

## Sandbox (виртуальный счёт, без реальных денег)

```bash
TINKOFF_SANDBOX=1 python sandbox_setup.py 100000   # разово: создать sandbox-счёт + пополнить
TINKOFF_SANDBOX=1 python main.py                   # запуск бота в песочнице
```

`TINKOFF_SANDBOX=1` переключает gRPC-таргет всех сервисов
(`invest_api/invest_target.py`) на `sandbox-invest-public-api`. Без этой
переменной бот всегда идёт на боевой эндпоинт — даже с sandbox-токеном
запрос будет отклонён, так что переменная и токен должны соответствовать
друг другу. `sandbox_setup.py` — разовый скрипт (не часть торгового цикла):
создаёт виртуальный счёт через `sandbox_open_account` (если уже есть —
переиспользует) и зачисляет виртуальные рубли через `sandbox_pay_in`.

## Структура файлов

```
invest-bot/
  trade_system/strategies/
    oi_composite_strategy.py   ← наша стратегия, экспонирует .confidence
    change_and_volume_strategy.py  ← оригинал (пример)
    strategy_factory.py        ← регистрация стратегий
  trading/
    trader.py                  ← signal_only режим + risk-gate перед открытием
  risk.py                      ← риск-менеджер (корреляционный риск,
                                  risk% от confidence, портфельный лимит,
                                  дневной стоп, безубыток, трейлинг)
  risk_config.py                ← константы риск-менеджмента (CORR_GROUPS и т.д.)
  oi_layers.py                  ← фоновый поллер ОИ (юр/физ), squeeze-score
  tradestats.py                  ← фоновый поллер микроструктуры (tradestats/
                                  obstats/orderstats), 7 методов
  regime.py                     ← классификация режима рынка + детекция
                                  точек излома (CUSUM/PELT/Z-Score)
  indicators.py                  ← Фаза 3 (часть 1): адаптивные MA + режимные
                                  индикаторы (KAMA/FRAMA/VIDYA/ZLEMA/T3,
                                  MMI/TII/ER/VHF/TPI/TQI)
  indicators_fractal.py          ← Фаза 3 (часть 2): фракталы (FDI/Hurst/PFE)
                                  + энтропия (Shannon/Permutation)
  indicators_ehlers.py           ← Фаза 3 (часть 3): Ehlers DSP (Cyber Cycle,
                                  Decycler, Fisherized RSI, Even Better Sinewave)
  indicators_volume.py           ← Фаза 3 (часть 4, финал): объём (Klinger/
                                  VZO/Twiggs), относит. сила (RMI), z-score
  mega_alerts.py                  ← фоновый суточный поллер аномалий по ВСЕМУ
                                  рынку (MOEX AlgoPack alerts.json)
  settings.ini                 ← пример конфига с OICompositeStrategy
  oi_weights.json              ← создаётся автоматически при первом запуске
  data/risk_state.json,
  data/open_positions.json,
  data/mega_alerts.json        ← состояние risk.py / mega_alerts.py,
                                  переживает рестарт
```

## Риск-менеджмент (risk.py)

Перед каждым реальным открытием позиции (`SIGNAL_ONLY=0`) `trader.py` спрашивает
`risk.can_open(ticker, direction, confidence)`:
- блокирует, если уже открыт противоположный лонг/шорт в той же корреляционной
  группе (`risk_config.CORR_GROUPS`) — все акции РФ по умолчанию одна группа;
- блокирует, если `confidence` (производная от composite-сигнала стратегии)
  ниже 55%;
- сжимает размер новой позиции, если суммарный риск портфеля близок к лимиту
  (`PORTFOLIO_RISK_MAX_PCT`).

Размер лота — `min(доступные деньги, риск-бюджет от confidence)`. Дневной
защитный стоп (`DAILY_MAX_LOSS_PCT`) блокирует новые входы до конца дня.

`confidence` стратегии = `0.5 + 0.5*|composite|` — приближение, так как
у composite-сигнала нет нативной вероятностной интерпретации.

## Squeeze-сигнал (oi_layers.py)

Фоновый сервис на торговый день: раз в 5 минут (ОИ на MOEX обновляется
только на границах :00/:05) тянет разбивку юр/физ по FutOI
(`analyticalproducts/futoi`, нужен `MOEX_TOKEN`) для тикеров из
`FUTOI_MAP`, строит слои ΔOI ({date, price, size}) и считает
squeeze_score — долю свежих (≤5 дней) и крупных (≥15% стороны) слоёв,
которые сейчас в минусе по цене. Это "кто-то быстро и крупно набрал
позицию, и движение против него" — не статичный порог вида "физики
держат 65% шорта".

Из того же FutOI-снэпшота (без дополнительных запросов) считаются ещё два
скора, которые подключены и как входные методы стратегии (`INST_OI`,
`RETAIL_CONTRA` выше), а не только в выход:
- `inst_oi_score` (m_INST_OI) — нетто-позиция юрлиц (YUR), нормированная
  на размер позиции стороны: > 0 — юрлица в нетто-лонге.
- `retail_contra_score` (m_RETAIL_CONTRA) — расхождение юр/физ по
  направлению: положительный, когда юрлица в лонге, а физлица в шорте
  (типичная картина перед разворотом, retail обычно догоняет движение
  последним).

squeeze_score (в отличие от inst_oi/retail_contra) используется только в
адаптивном выходе (см. ниже), не как отдельный сигнал на вход.

## Микроструктура (tradestats.py)

Отдельный фоновый поллер (не путать с `oi_layers.py` — другие данные, другая
частота). Внутридневные данные MOEX AlgoPack `datashop/algopack/eq/{tradestats,
obstats,orderstats}` обновляются гораздо чаще FutOI, без фиксированной границы
:00/:05 — поллим раз в `POLL_SECONDS` (60 сек), храним скользящее окно
`ROLLING_WINDOW` (30) баров на тикер по каждому из трёх эндпоинтов.

Методы (порт из oi-signal-v10.html):
- `m_BS_PRESSURE` (tradestats: vol_b/vol_s) — давление покупателей/продавцов
  по объёму инициированных сделок.
- `m_AGGRESSOR_FLOW` (tradestats: val_b/val_s, trades_b/trades_s) — объём +
  число сделок по инициатору, взвешенная комбинация.
- `m_LARGE_IMPACT` (tradestats: vol_b/vol_s/vol) — перекос крупных
  (объём ≥ p75 окна) сделок по стороне.
- `m_VWAP_SIGNAL` ts-вариант (tradestats: pr_close/pr_vwap) — отклонение
  цены от внутридневного VWAP, масштаб по волатильности последних баров
  (вместо ATR — pstdev(pr_close)/mean, минимум 0.5%).
- `m_VOL_MOMENTUM` ts-вариант (tradestats: vol, pr_close) — аномальный
  объём (по перцентилям p10/p50/p90 окна) × направление цены.
- `m_OB_IMBALANCE` (obstats: imbalance_vol_bbo) — перекос объёма в стакане
  у лучшей цены.
- `m_CANCEL_SIGNAL` (orderstats: cancel_orders_b/cancel_orders_s) — перекос
  отмен заявок по стороне.

Без `MOEX_TOKEN` (или без подписки AlgoPack на эти эндпоинты) `poll_loop`
выходит сразу, методы молчат (score=0) — так же, как OI_SQUEEZE без токена.

## Аномалии по всему рынку (mega_alerts.py)

Ответ на «кто обновляет базу данных по всем тикерам» — порт `fetchMegaAlerts`/
`loadMegaAlerts` из oi-signal-v10.html. В отличие от `oi_layers.py` и
`tradestats.py` (поллят только сконфигурированные в `settings.ini` тикеры),
MOEX AlgoPack `datashop/algopack/{eq,fo}/alerts.json` отдаёт срез аномалий
(объём/движение) по **всему рынку** одним запросом — это и есть автоматически
обновляемая база поверх детального композита. Требует MOEX_TOKEN с подпиской
на alerts.json.

`MegaAlertsService.daily_loop()` — фоновая задача, живёт весь процесс (не
только торговый день, в отличие от oi_task/tradestats_task): обновляет срез
сразу при старте и затем раз в 24 часа, хранит последние `DAYS_KEPT` (14) дней
в `data/mega_alerts.json`. В начале каждого `trade_day` бот:
1. форсирует `refresh_once()` (актуальный срез на сегодня);
2. сверяет, какие из сегодняшних `settings.ini`-тикеров попали в alerts
   (`tracked_hits`);
3. собирает список тикеров с аномалией, которых нет в `settings.ini`
   (`extra_tickers`) — это и есть "недостающие части", по которым бот пока
   не строит детальный композит, но видит, что рынок их отметил;
4. шлёт оба списка в Telegram через `Blogger.mega_alerts_message`.

`extra_tickers` сейчас только уведомление (бот не торгует тикеры вне
`settings.ini` автоматически) — расширение списка отслеживаемых тикеров на
основе этого сигнала остаётся ручным шагом пользователя.

## Адаптивный выход (ADAPTIVE_EXIT=1)

По умолчанию выход — фиксированный stop/take уровень сигнала стратегии.
При `ADAPTIVE_EXIT=1` (env) для тикеров с известным squeeze включается
альтернативный режим: `risk.check_exit` — трейлинг Chandelier,
безубыток после 1R, giveback-защита пика, плюс ранний выход из шорта
при squeeze-риске. Это один из возможных режимов работы, не замена
take_profit по умолчанию.

## Что планируется добавить

- Фаза 3 (опционально, низкий приоритет): Mansfield RS / Beta-adjusted RS
  не портированы — требуют отдельного ряда бенчмарка (индекса), которого
  у стратегии нет (один тикер). Расширенная волатильность (Parkinson/
  Garman-Klass/Yang-Zhang/Ulcer) не даёт направления само по себе — не
  портирована как отдельный метод композита.
- Сохранение истории сигналов в Cloudflare D1 (как в oi-signal-v10)
- Информационная теория + Ising/QUBO-оптимизатор весов (`lib-infotheory-opt.js`)
  как альтернатива текущей простой EWA-калибровке весов
