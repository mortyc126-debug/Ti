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
    oi_composite_strategy.py   ← наша стратегия
    change_and_volume_strategy.py  ← оригинал (пример)
    strategy_factory.py        ← регистрация стратегий
  trading/
    trader.py                  ← добавлен signal_only режим
  settings.ini                 ← пример конфига с OICompositeStrategy
  oi_weights.json              ← создаётся автоматически при первом запуске
```

## Что планируется добавить

- Подтяжка MOEX AlgoPack данных (OI, tradestats, obstats) как дополнительные методы
- Интеграция с `indicators-lib.js` методами (портирование на Python)
- Сохранение истории сигналов в Cloudflare D1 (как в oi-signal-v10)
