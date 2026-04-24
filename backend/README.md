# Backend — бэкенд БондАналитика

Серверная часть для автоматизированного фонового сбора данных и долговременного
хранения. Пилот: ежедневный сбор акций MOEX (TQBR) + фьючерсов на акции (FORTS)
+ расчёт **basis** — расхождения между спотом и ближайшим фьючерсом.

## Почему basis

`basis = цена фьючерса − (цена акции × размер лота)`

- Положительный basis (**контанго**) — фьючерс дороже спота. Обычно отражает
  стоимость удержания позиции (процентная ставка) или ожидание роста.
- Отрицательный (**бэквордация**) — фьючерс дешевле. Может означать
  ожидание дивидендов, давление продаж, конкретные события.
- Аннуализированный basis (`basis_ann = basis_pct × 365/days_to_expiry`)
  сравнивает между разными экспирациями, удобно строить единый ряд.

Изменения basis часто **упреждают** движение самой цены акции — это одна
из классических стратегий (cash-and-carry arbitrage, событийный шорт).

## Стоимость

**$0/мес** на вашем объёме: Cloudflare Workers free tier (100k req/день),
D1 free tier (5 ГБ, 5M чтений/день). Накопленные данные годами уложатся
в лимиты.

## Разворачивание (15 минут, один раз)

### 0. Предварительно

- Аккаунт на https://dash.cloudflare.com (у вас уже есть).
- Node.js 18+ (`node --version`).
- Репозиторий склонирован локально.

### 1. Установить wrangler

```sh
npm install -g wrangler
```

### 2. Логин

```sh
wrangler login
```

### 3. Создать БД

```sh
wrangler d1 create bondan-db
```

Ответ будет содержать `database_id` (hex с дефисами). Скопировать.

### 4. Вписать database_id в wrangler.toml

В `backend/wrangler.toml` заменить `PUT_YOUR_DATABASE_ID_HERE` на
скопированный ID.

### 5. Создать схему таблиц

```sh
wrangler d1 execute bondan-db --file=backend/schema.sql
```

Три таблицы: `stock_daily`, `futures_daily`, `collection_log`.

### 6. Задать секрет для админ-endpoint'ов

```sh
wrangler secret put ADMIN_TOKEN
```

Ввести длинную случайную строку (например, `openssl rand -hex 16`).
Нужна для `/collect/*` POST-вызовов.

### 7. Задеплоить

```sh
cd backend && wrangler deploy
```

В ответе будет URL вида `https://bondan-backend.<account>.workers.dev`.

### 8. Проверка

```sh
curl https://bondan-backend.<account>.workers.dev/status
```

Должно быть `{"ok": true, "db": {"stock_daily_rows": 0, ...}}`.

### 9. Первый сбор руками

```sh
curl -X POST -H "X-Admin-Token: ВАШ_ТОКЕН" \
  https://bondan-backend.<account>.workers.dev/collect/stock

curl -X POST -H "X-Admin-Token: ВАШ_ТОКЕН" \
  https://bondan-backend.<account>.workers.dev/collect/futures
```

После этого `/status` покажет заполненные таблицы.

## Endpoints

### Статус

`GET /status` — строк в БД, последние 5 запусков cron.

### Акции

- `GET /stock/latest?limit=500` — свежий снапшот всех акций TQBR,
  отсортировано по обороту.
- `GET /stock/history?secid=SBER&from=2024-01-01&to=2026-12-31` —
  история одной акции.

### Фьючерсы

- `GET /futures/latest?asset=SBER` — все живые фьючерсы на SBER
  (с разными экспирациями). Без `asset` — все.
- Без фильтра выводит по порядку `asset_code → expiry`.

### Basis

- `GET /basis?asset=SBER` — прямо сейчас:
  ```json
  {
    "asset": "SBER",
    "stock": { "price": 312.45, "spot_value_per_lot": 31245 },
    "futures": { "secid": "SBRU6", "price": 31500, "expiry": "2026-09-15" },
    "basis": { "rub": 255, "pct": 0.816, "pct_annualized": 2.12,
               "days_to_expiry": 140, "direction": "contango..." }
  }
  ```
- `GET /basis/history?asset=SBER&from=2020-01-01` — временной ряд для
  построения графика basis_pct за всё накопленное.

### Ручной запуск

- `POST /collect/stock` — запросить TQBR прямо сейчас.
- `POST /collect/futures` — FORTS.
- Оба требуют заголовок `X-Admin-Token: <ваш секрет>`.

## Cron

Каждое утро в 10:30 по Москве (07:30 UTC) Worker автоматически:
1. Тянет TQBR → пишет в `stock_daily` (UPSERT).
2. Тянет FORTS → пишет в `futures_daily` (UPSERT).
3. Логирует оба запуска в `collection_log`.

Проверить что cron сработал: `GET /status`, смотреть `recent_runs[0]`.

## Дальше

После того как бэкенд живёт неделю-две и накопились данные:

1. **Клиент подключается к бэкенду.** Новый модуль в `app.js` —
   `BACKEND_URL` в `localStorage['bondan_backend_url']`. Страница
   «🔗 Связи» или новая «📉 Basis» читает ряды из `/basis/history`.
2. **Добавить коллекторы**: FRED (сырьё, DXY, US ставки), CPI/КС
   с cbr.ru. Каждый источник → своя таблица + endpoint.
3. **Cerebras через Worker.** Ключ хранится в секретах Cloudflare
   (не в браузере). Endpoints `/ai/extract` для HTML-парсинга.
4. **Миграция localStorage → D1.** `portfolio`, `reportsDB` по одному
   разделу переходят из клиента в БД.
5. **ML-сигналы.** Отдельная Python-функция (Fly.io free) или скрипт
   в D1-query: Granger-causality, feature importance, event study.
6. **Алерты.** Telegram-бот при срабатывании сигнала.

## Troubleshooting

- **`D1_ERROR: no such table`** — не запустили `schema.sql`. Шаг 5.
- **`401 unauthorized`** на `/collect` — не совпадает `X-Admin-Token`.
  Перепроверить `wrangler secret put ADMIN_TOKEN`.
- **Cron не срабатывает** — проверить в dashboard Cloudflare: Workers
  → bondan-backend → Triggers. Должна быть строка `30 7 * * *`.
- **Логи в реальном времени**: `wrangler tail bondan-backend`.
- **Фьючерсы не нашлись** — у MOEX FORTS `ASSETCODE` может для
  некоторых старых контрактов отличаться. В парсере стоит фильтр
  `^[A-Z]{4,6}$` (только буквы, 4-6 символов). Для специфичных случаев
  (Si, Eu) фильтр пропустит — это нормально для MVP фокуса на акциях.

## Ограничения этой версии

- Собирается только **«текущий срез»** — одна строка на бумагу в день.
  Внутридневных данных нет. Для вашей задачи этого пока достаточно.
- Исторических данных **назад во времени нет** — БД наполняется с
  сегодняшнего дня. Через 6 месяцев будет полгода истории, через
  год — год.
- Для построения исторических basis нужно, чтобы и акция, и фьючерс
  торговались в эти даты. Экспирация каждые 3 месяца, поэтому для
  каждой конкретной пары basis непрерывен в пределах 3 мес.
