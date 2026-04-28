# TRACK C — Корпоративные события и раскрытия

## Цель

Создать ленту корпоративных событий по эмитентам облигаций: погашения,
оферты, дивиденды, реструктуризации, технические дефолты, смена
руководства, M&A, рейтинговые действия (если до TRACK D ещё не дошло).
Это вторая важнейшая компонента стресс-индекса — фундаменталка двигается
медленно, события — быстро.

## Источники

| Источник | Доступ | Содержание |
|---|---|---|
| **MOEX** `/iss/securities/{secid}/events.json` | прямой, JSON | купоны, погашения, оферты для облигации (известные плановые события) |
| **e-disclosure.ru** | ❌ JS-challenge | СвАЛ, корп. действия — нужен Browserless ($30/мес) или Cerebras-парсинг snippet'ов |
| **Smart-Lab events feed** (`smart-lab.ru/q/shares/order_by_div_yield/`) | прямой | дивиденды, рекомендации СД |
| **Cbonds news** (`cbonds.ru/news/`) | прямой? проверить anti-bot | новости рынка с тегами эмитентов |
| **Telegram-каналы** (`@vdocondor`, `@cbonds`, `@bondsobligation`) | через MTProto bridge или RSS-конвертер | свежие события ВДО |
| **РБК Investments / Интерфакс** RSS | прямой | макро-новости с упоминаниями эмитентов |

## Подход

Из-за anti-bot на e-disclosure делаем **гибрид**:

1. **MOEX events** — основа, известные плановые события (~95% покрытия
   по купонам/офертам/погашениям). Прямой парсинг, без LLM.
2. **RSS-агрегатор** — собираем 2-3 RSS-источника, прогоняем через
   Cerebras (быстро/дёшево, 70b llama) с промптом «классифицируй и
   привяжи к ИНН». Получаем `issuer_events` с типом и severity.
3. **Telegram-каналы** — отдельный микро-сервис (не в worker, лучше
   на Fly.io / Railway free) который слушает каналы и пушит JSON
   на наш `/collect/events/inbox?source=telegram`.

## Схема D1

```sql
CREATE TABLE IF NOT EXISTS issuer_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  inn          TEXT,                 -- может быть null если не привязали
  secid        TEXT,                 -- ISIN/SECID если событие по конкретной бумаге
  event_date   TEXT NOT NULL,        -- YYYY-MM-DD когда событие случится/случилось
  event_type   TEXT NOT NULL,        -- см. словарь ниже
  severity     TEXT,                 -- 'critical' | 'high' | 'medium' | 'low'
  title        TEXT,
  summary      TEXT,                 -- 1-2 предложения от LLM
  amount_rub   REAL,                 -- если применимо (купон, дивиденд)
  source       TEXT NOT NULL,        -- 'moex' | 'edisc' | 'smartlab' | 'rss-rbc' | 'telegram-vdocondor'
  source_url   TEXT,
  raw          TEXT,                 -- сырой JSON источника для отладки
  fetched_at   TEXT NOT NULL,
  UNIQUE (inn, event_date, event_type, source) ON CONFLICT IGNORE
);
CREATE INDEX IF NOT EXISTS idx_events_inn ON issuer_events(inn);
CREATE INDEX IF NOT EXISTS idx_events_date ON issuer_events(event_date);
CREATE INDEX IF NOT EXISTS idx_events_type ON issuer_events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_sev ON issuer_events(severity);
```

### Словарь event_type

```
'coupon'           — купонная выплата (плановая)
'maturity'         — погашение
'offer'            — оферта (put/call)
'amortization'     — частичное погашение
'dividend'         — дивиденды (для акций)
'rating_change'    — рейтинговое действие (если не в TRACK D)
'default_tech'     — технический дефолт
'default'          — реальный дефолт
'restructuring'    — реструктуризация
'share_issue'      — допэмиссия
'share_buyback'    — выкуп
'asset_sale'       — продажа крупного актива
'merger'           — M&A
'management_chg'   — смена CEO/председателя СД
'guidance_chg'     — изменение прогноза руководством
'litigation'       — крупный судебный иск
'sanction'         — санкции / ограничения
'covenant_breach'  — нарушение ковенантов
'other'            — прочее
```

### Severity (правила автоматической разметки)

- `critical` — default, default_tech, restructuring, sanction, covenant_breach
- `high` — rating_change (понижение), management_chg (CEO), litigation (>1 млрд ₽)
- `medium` — offer, amortization, share_issue, asset_sale, merger
- `low` — coupon, dividend, share_buyback, guidance_chg

## Endpoints

- `POST /collect/events/moex?limit=100` — обходит активные ISIN'ы из
  bond_daily, тащит /iss/securities/{secid}/events.json. Только known
  scheduled events.
- `POST /collect/events/rss?feed=rbc-investments` — прогоняет RSS,
  Cerebras классифицирует, привязывает к ИНН по упоминанию имени.
- `POST /collect/events/inbox` — endpoint для внешних push'ей
  (Telegram-listener шлёт сюда). Body: `{source, items: [{date, title, body, url}]}`.
- `GET /issuer/{inn}/events?from=2025-01-01&type=coupon,offer` —
  лента событий эмитента.
- `GET /events/feed?severity=high&from=2026-04-01` — общая лента
  для главной страницы.
- `GET /events/upcoming?days=30` — будущие плановые события.

## LLM-промпт для классификации (Cerebras)

```
Дан текст новости/раскрытия. Извлеки:
- issuer_name (точное название) или null
- issuer_inn (10-12 цифр) или null
- event_date (YYYY-MM-DD; для будущих — плановая)
- event_type (см. словарь)
- severity
- title (короткий, до 80 симв.)
- summary (1-2 предложения)
- amount_rub (если есть сумма) или null

Верни строго JSON. Не выдумывай — null лучше неточного.
```

## Subrequest / time budget

- `events/moex` — 1 fetch на ISIN, до 100 → 100 fetch'ей. Free tier
  лимит 50 — нужна пагинация по 30-40 ISIN на вызов.
- `events/rss` — 1 fetch на RSS + N×Cerebras (по 1 секунде). 30 новостей
  ~ 30 сек wall-clock.

## Acceptance criteria

- [ ] `events/moex` за один прогон тащит купоны/оферты/погашения
  по 30 ISIN.
- [ ] `events/rss` для одного фида классифицирует и пишет 5-20 событий
  с привязкой к ИНН (via fuzzy match на имя в issuers).
- [ ] `GET /events/feed` возвращает массив с разнообразием event_type.
- [ ] В `/status` поле `events_count_30d` >= 100 после первой недели.

## Что не делать

- Не парсить e-disclosure напрямую — это отдельная инфраструктура
  (Browserless / Cerebras с короткими снипп) — отложить.
- Не классифицировать события через Grok (платно, медленно). Cerebras
  быстрее и дешевле для bulk classification.
- Не делать сентимент-анализ — это шум.
