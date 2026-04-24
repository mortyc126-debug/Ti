# Backend — бэкенд БондАналитика

Серверная часть для автоматизированного фонового сбора данных и долговременного
хранения. Пилотная версия: один Cloudflare Worker + D1 (SQLite) + ежедневный
cron, который тянет котировки ОФЗ с MOEX.

## Зачем это

До сих пор всё хранилось в браузерном `localStorage` (лимит ~5 МБ) и собиралось
только когда вы сами открывали приложение. Бэкенд снимает оба ограничения:
5 ГБ бесплатной БД и фоновой сбор данных каждую ночь без вашего участия.

**Стоимость**: $0/мес на вашем объёме и в обозримом будущем. Cloudflare
Workers free tier — 100k запросов/день, D1 free tier — 5 ГБ / 5M чтений / 100k
записей в сутки. Превышений не ожидается.

## Разворачивание (15 минут, один раз)

### 0. Предварительно

- У вас должен быть аккаунт на https://dash.cloudflare.com (уже есть).
- Установлен Node.js 18+ (проверить: `node --version`).
- Локально склонирован этот репозиторий.

### 1. Установить wrangler (Cloudflare CLI)

```sh
npm install -g wrangler
```

### 2. Логин в Cloudflare

```sh
wrangler login
```

Откроется браузер, подтверждаете доступ wrangler'а к аккаунту.

### 3. Создать БД D1

```sh
wrangler d1 create bondan-db
```

В ответе будет что-то вроде:

```
✅ Successfully created DB 'bondan-db'
[[d1_databases]]
binding = "DB"
database_name = "bondan-db"
database_id = "abc123de-4567-89ab-cdef-0123456789ab"
```

**Скопируйте `database_id`** (32-значный hex с дефисами).

### 4. Вписать database_id в wrangler.toml

Откройте `backend/wrangler.toml` и замените `PUT_YOUR_DATABASE_ID_HERE` на
скопированный ID.

### 5. Создать схему таблиц

```sh
wrangler d1 execute bondan-db --file=backend/schema.sql
```

Должно ответить «Executed 2 commands in XXms» или подобное.

### 6. Задать секрет для админ-endpoint'а (для /collect POST)

```sh
wrangler secret put ADMIN_TOKEN
```

Попросит ввести значение — придумайте длинную случайную строку
(например `openssl rand -hex 16`) и сохраните её где-то. Она нужна для
ручного запуска коллектора по HTTP.

### 7. Задеплоить Worker

```sh
cd backend && wrangler deploy
```

(Или из корня: `wrangler deploy --config backend/wrangler.toml`.)

В ответе будет URL Worker'а:

```
https://bondan-backend.<ваш-аккаунт>.workers.dev
```

Сохраните — это адрес бэкенда.

### 8. Проверить что живо

```sh
curl https://bondan-backend.<ваш-аккаунт>.workers.dev/status
```

Должен вернуть JSON вида:

```json
{
  "ok": true,
  "db": { "ofz_daily_rows": 0, "ofz_latest_date": null },
  "last_run": null,
  "version": "0.1-pilot"
}
```

### 9. Запустить первый сбор руками (чтобы не ждать 10:00 утра)

```sh
curl -X POST -H "X-Admin-Token: ВАШ_ADMIN_TOKEN" \
  https://bondan-backend.<ваш-аккаунт>.workers.dev/collect/ofz
```

Ответ:

```json
{
  "status": "ok",
  "boards": ["TQOB", "TQCB"],
  "rowsTotal": { "inserted": 47, "updated": 0 },
  "duration_ms": 1823
}
```

После этого `/status` покажет `ofz_daily_rows: 47` и дату последнего запуска.

Повторите `/status` и `/ofz/latest` чтобы убедиться что данные
действительно сохранились.

## Endpoints

| Метод + путь | Что делает |
|---|---|
| `GET /status` | Диагностика: сколько строк в БД, когда последний сбор. |
| `GET /ofz/latest?limit=N` | Свежий снапшот ОФЗ (одна строка на выпуск). |
| `GET /ofz/history?secid=SU26238RMFS4&from=2026-01-01&to=2026-12-31` | История одной бумаги. |
| `POST /collect/ofz` | Ручной запуск коллектора. Требует заголовок `X-Admin-Token`. |

## Cron

Каждое утро в 10:00 по Москве (07:00 UTC) Worker автоматически дёргает
`collectOfz`. Вы ничего не нажимаете.

Проверить что cron сработал: `GET /status` — смотреть `last_run.started_at`.

## Дальше

Следующие шаги (не в этом коммите):

1. **Фронтенд подключается к бэкенду.** Новый модуль в `app.js`,
   endpoint `BACKEND_URL` хранится в `localStorage['bondan_backend_url']`.
   Страница «🔗 Связи» при необходимости подтягивает ряды из бэкенда
   вместо клиентского `localStorage.bondan_ratecb_cbrdata`.
2. **Добавить коллекторы**: CPI/КС/курс с cbr.ru, существенные факты
   с e-disclosure, корпоративные облигации (TQCB с пагинацией).
3. **Cerebras интеграция.** ИИ-парсер для страниц с нестандартной
   разметкой. Прокси через этот же Worker (плюсом ключ хранится в
   секретах Cloudflare, не в браузере).
4. **Миграция localStorage → D1.** По одному разделу за раз:
   `portfolio`, `reportsDB`, `ytmBonds`. Клиент ходит в API, не в
   `localStorage`.

## Troubleshooting

- **`D1_ERROR: no such table: ofz_daily`** — не запустили `schema.sql`.
  Повторите шаг 5.
- **`401 unauthorized` на /collect** — неправильный `X-Admin-Token` или
  секрет не задан. Перепроверьте `wrangler secret put ADMIN_TOKEN`.
- **Cron не срабатывает** — проверьте вкладку Triggers в dashboard
  Cloudflare (Workers → bondan-backend → Triggers). Должна быть запись
  `0 7 * * *`.
- **Ошибки в логах** — `wrangler tail bondan-backend` показывает
  realtime-логи Worker'а (включая `console.error` из cron).
