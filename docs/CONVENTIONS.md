# CONVENTIONS — протокол совместной разработки

Минимум правил, чтобы 9 параллельных веток слились без конфликтов.

## 1. Одна ветка = одна зона

В `backend/worker.js` каждый track работает между маркерами:

```js
// ═══ TRACK X: <name> ═══════════════════════════════════════════════
// (всё что внутри принадлежит ветке X)
async function trackXCollector(env, url) { ... }
function trackXHelper(...) { ... }
// ═══ END TRACK X ═════════════════════════════════════════════════════
```

**Не редактировать** код вне своей зоны, кроме:
- Добавление маршрутов в `fetch(req, env)` — каждая ветка добавляет свою
  строку под пометкой `// TRACK X route`.
- Добавление в `handleStatus` — отдельный блок `let trackXStats = {};`
  и `...trackXStats` в `db: {...}`.

## 2. Schema migrations

Каждая ветка кладёт свою миграцию в `backend/migrations/<track>_<slug>.sql`.
Файл идемпотентен (использует `CREATE TABLE IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`).

Миграции существующих таблиц (ALTER TABLE ADD COLUMN) — **только через
auto-migrate в worker.js**, в `try/catch`, чтобы ошибка «duplicate column»
не валила весь коллектор. Пример — `issuers.kind` в TRACK 0.

В `backend/schema.sql` — синхронизация только при PR-merge мейнтенером.

## 3. Endpoint conventions

- **GET** — read-only, без X-Admin-Token. CORS `*`.
- **POST `/collect/<track>`** — collector, требует X-Admin-Token, всегда
  возвращает JSON `{source, processed, succeeded, errors[], duration_ms}`.
- **GET `/issuer/{inn}/<feature>`** — feature-specific data на эмитента.
  Если пусто — `{inn, data: [], generatedAt}`, не 404.
- **GET `/<entity>/latest`**, **/<entity>/history** — для хвостовых данных.
- Параметры:
  - `?limit=N` (default 30, max 100)
  - `?max_ms=N` (default 25000)
  - `?force=1` (игнорировать кеш/cooldown)
  - `?inn=X` (один ИНН вместо очереди)
  - track-specific флаги — с явным префиксом, напр. `?include_news=1`

## 4. Cooldown / rate-limit

Если коллектор пишет в очередь (как `reports_queue`):
- success → +30 days
- partial (получили старое) → +7 days
- miss → +14 days, после 3 раз → +90 days

Соблюдение subrequest-budget на free tier:
- DaData: ~1 req/inn
- ГИР БО: ~3-7 req/inn (при отключённом auto-disable)
- buxbalans: 1 req/inn (с retry)
- zachBiz: 1-2 req/inn
- Cerebras/Grok: 1 req/inn

## 5. Идемпотентность

Все INSERT — `ON CONFLICT DO UPDATE` (UPSERT). Коллектор должен быть
безопасен для повторного запуска. Никаких side-effects кроме DB-записи.

## 6. Авто-миграция в коллекторе

```js
async function trackXCollector(env, url){
  // Безопасные ALTER в catch — ловим duplicate column.
  for(const col of ['my_field TEXT', 'my_other REAL']){
    try { await env.DB.prepare(`ALTER TABLE my_table ADD COLUMN ${col}`).run(); }
    catch(_){}
  }
  // Безопасный CREATE — всегда IF NOT EXISTS.
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS my_table (...)`).run();
  } catch(_){}
  // ...рабочий код...
}
```

## 7. Time budget

```js
async function trackXCollector(env, url){
  const t0 = Date.now();
  const maxMs = parseInt(url?.searchParams?.get('max_ms') || '25000', 10);
  let timedOut = false;
  for(const item of queue){
    if(Date.now() - t0 > maxMs - 3000){ timedOut = true; break; }
    // ...работа...
  }
  return { ..., timedOut, duration_ms: Date.now() - t0 };
}
```

## 8. Логирование в collection_log

Каждый коллектор в конце:

```js
await logRun(env, startedAt, 'track_x', rowsWritten, errors, Date.now() - t0);
```

`logRun` уже есть в worker.js. Source-prefix должен быть уникальным
на ветку (`'macro'`, `'events'`, `'ratings'`, `'orderbook'`, etc).

## 9. Версионирование

В каждом merge'е bumpAется `version` в `/status`:
- `0.9.0`, `0.9.1`, ... — мажор минор патч
- суффикс — короткий name трека: `0.10.0-macro`, `0.10.1-events`

Только мейнтенер ветки `claude/wizardly-feynman-64TbH` ставит версию.
Внутри своей ветки можно держать `0.X.Y-trackN-WIP`.

## 10. Стиль кода

- Комментарии — по-русски. Объясняем **почему**, а не **что**.
- 2-space indent, single quotes, no trailing semicolons где можно.
- `async/await`, не `.then()`.
- Никаких внешних npm-зависимостей в worker (он бандлится без bundler).
- Один файл — одна ветка (в worker'е). Если ветка очень большая —
  выносим helper'ы в `backend/<track>-helpers.js` ESM-импортом
  (но это опционально, проще держать в одной зоне worker.js).

## 11. Тестирование

- Если есть нетривиальный парсер (regex, JSON-нормализация), оставить
  прямо в комментарии 1-2 примера input→output.
- Перед коммитом — `node --input-type=module --check < backend/worker.js`.
- Schema валидируется python-skript: `python3 -c "import sqlite3; sqlite3.connect(':memory:').executescript(open('backend/schema.sql').read())"`.

## 12. Pull request checklist

- [ ] worker.js синтаксически валиден
- [ ] schema.sql валиден (python sqlite3 не падает)
- [ ] Версия в /status поднята
- [ ] Endpoint'ы документированы в шапке worker.js
- [ ] Зона маркирована `// ═══ TRACK X ═══`
- [ ] Идемпотентно (запустить дважды — не ломается)
- [ ] Бюджет времени и subrequest'ов уважается
- [ ] В `docs/tracks/X_*.md` обновлено состояние («done» / open issues)
