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

Режим рынка (VHF) используется как множитель надёжности, не как отдельный сигнал.

Все скоры ∈ [-1, 1]. Итоговый composite = взвешенная сумма × режим рынка.

## Обучение весов

Веса методов обновляются через EWA (α=0.1) после каждого закрытия сделки.  
Метрика качества — MFE/(MFE+MAE) — непрерывный [0,1] результат, не бинарный.  
Сохраняются в `oi_weights.json` рядом с `main.py`.

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
- `TOKEN` — токен T-Invest (readonly для SIGNAL_ONLY, полный для торговли)
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — для уведомлений

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
  settings.ini                 ← пример конфига с OICompositeStrategy
  oi_weights.json              ← создаётся автоматически при первом запуске
  data/risk_state.json,
  data/open_positions.json     ← состояние risk.py, переживает рестарт
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

squeeze_score используется только в адаптивном выходе (см. ниже), не
как отдельный сигнал на вход.

## Адаптивный выход (ADAPTIVE_EXIT=1)

По умолчанию выход — фиксированный stop/take уровень сигнала стратегии.
При `ADAPTIVE_EXIT=1` (env) для тикеров с известным squeeze включается
альтернативный режим: `risk.check_exit` — трейлинг Chandelier,
безубыток после 1R, giveback-защита пика, плюс ранний выход из шорта
при squeeze-риске. Это один из возможных режимов работы, не замена
take_profit по умолчанию.

## Что планируется добавить

- Подтяжка MOEX AlgoPack данных (OI, tradestats, obstats) как дополнительные методы
- Интеграция с `indicators-lib.js` методами (портирование на Python)
- Сохранение истории сигналов в Cloudflare D1 (как в oi-signal-v10)
