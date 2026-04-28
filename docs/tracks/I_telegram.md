# TRACK I — Telegram-бот алертов

## Цель

Telegram-бот, который шлёт пользователю **оповещения** о критических
событиях по эмитентам в его watchlist'е:
- Появилось новое событие severity='critical' или 'high'.
- Стресс-индекс эмитента вырос за день > 20 пунктов.
- Рейтинговое действие (понижение / placement under review).
- Цена облигации упала > 5% за день.

Также отвечает на простые команды:
- `/watch ISIN` / `/watch ИНН` — добавить в watchlist
- `/unwatch ...`
- `/status` — текущее состояние портфеля
- `/risk ISIN` — risk_card по эмитенту
- `/portfolio` — список watchlist

## Зависимости

- TRACK C (events) — главный источник алертов.
- TRACK E (stress) — для алертов о росте стресса.
- TRACK D (ratings) — рейтинговые алерты.
- TRACK F (risk) — для команды `/risk`.

## Архитектура

**Отдельный CF Worker** `bondan-telegram-bot` (не в основном bondan-backend)
— потому что Telegram присылает webhook'и с непредсказуемой нагрузкой,
не хочется их смешивать с коллекторами. Воркер тонкий: принимает webhook,
делает запрос в bondan-backend, форматирует и отправляет ответ.

```
[Telegram] → webhook → [bondan-telegram-bot worker]
                              ↓ HTTP fetch
                         [bondan-backend /issuer/.../...]
                              ↓
                         JSON response
                              ↓
                         форматирование Markdown
                              ↓
                       Telegram sendMessage
```

## Файлы (зона ветки)

```
backend/telegram/
├── worker.js                    # отдельный Worker
├── wrangler.toml                # отдельный конфиг
├── schema.sql                   # отдельная D1 (или общая?)
└── README.md                    # как разворачивать
```

Решение: использовать **ту же D1 `coldline`** через cross-worker DB
binding в `wrangler.toml`. Так нет дубликата состояния.

## Схема D1

```sql
CREATE TABLE IF NOT EXISTS tg_subscribers (
  chat_id      INTEGER PRIMARY KEY,
  username     TEXT,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT,
  active       INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tg_watchlist (
  chat_id      INTEGER NOT NULL,
  inn          TEXT NOT NULL,
  added_at     TEXT NOT NULL,
  PRIMARY KEY (chat_id, inn)
);
CREATE INDEX IF NOT EXISTS idx_tgwl_inn ON tg_watchlist(inn);

CREATE TABLE IF NOT EXISTS tg_alerts_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  inn         TEXT,
  alert_type  TEXT NOT NULL,
  message     TEXT,
  sent_at     TEXT NOT NULL,
  delivered   INTEGER DEFAULT 1
);
```

## Роуты бота

```
/start         — приветствие, инструкция
/watch ИНН     — добавить эмитента в watchlist
/watch ISIN    — то же, но через bond_daily.emitent_inn
/unwatch ...
/list          — список watchlist
/status        — общая статистика (счётчики из /status)
/risk ИНН      — текущая risk_card
/events ИНН    — последние 5 событий
/portfolio     — то же что /list но с краткими цифрами
/help
```

## Доставка алертов

В **bondan-backend** новый endpoint:
- `POST /alerts/dispatch` (auth admin) — собирает критические события
  за последние N часов и шлёт subscribers'ам через telegram-bot worker.

Логика (ежечасный cron):
1. SELECT events WHERE severity IN ('critical', 'high') AND created_at > last_dispatch
2. Для каждого события:
   - SELECT chat_id FROM tg_watchlist WHERE inn = events.inn
   - Для каждого подписчика: формируем сообщение, шлём, логируем в tg_alerts_log
3. UPDATE alerts_dispatch_state SET last_dispatch = NOW()

## Telegram API

Чтобы не зависеть от ботбиблиотек:
- POST `https://api.telegram.org/bot{TOKEN}/sendMessage` с body `{chat_id, text, parse_mode: 'Markdown'}`
- Webhook setup: `https://api.telegram.org/bot{TOKEN}/setWebhook?url={our_worker}/webhook`

## Secrets

- `TELEGRAM_BOT_TOKEN` (через `wrangler secret put`)
- `BACKEND_URL` (env var в wrangler.toml)
- `BACKEND_ADMIN_TOKEN` (для звонков в /alerts/...)

## Acceptance criteria

- [ ] Бот регистрируется через webhook, отвечает на `/start`.
- [ ] `/watch 7707083893` (Сбербанк) добавляет в watchlist, через
  `/list` видно.
- [ ] `/risk 7707083893` возвращает форматированную risk_card.
- [ ] `/alerts/dispatch` (cron) шлёт сообщение при свежем событии
  severity='high' для эмитента в watchlist.
- [ ] `tg_alerts_log` фиксирует доставку.

## Что не делать

- Не делать оплаты / inline keyboards для рынка — это инвест-сервис,
  не магазин.
- Не делать чат с LLM (`«поговори со мной»`) — это другой проект.
- Не отправлять цены/котировки в реальном времени — это уход от
  алертной модели в стрим.
- Не шлёт алерт чаще 1 раза в сутки на (chat × inn × event_type).
