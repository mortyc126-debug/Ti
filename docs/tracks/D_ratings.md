# TRACK D — Рейтинговые действия

## Цель

Собрать историю рейтинговых действий (присвоение, повышение, понижение,
отзыв, выводы из reviewing) от трёх российских агентств: **АКРА**,
**Эксперт-РА**, **НКР**. У каждого эмитента может быть рейтинг от
одного-трёх. Это критическая входная переменная для default predictor
и для UI «карточка эмитента».

## Источники

| Агентство | URL | Формат | Доступ |
|---|---|---|---|
| **АКРА** | `https://www.acra-ratings.ru/api/ratings/issuers/` | JSON | прямой ✅ |
| **АКРА** новости | `https://www.acra-ratings.ru/api/news/` | JSON | прямой ✅ |
| **Эксперт-РА** | `https://raexpert.ru/api/v3/ratings/` | JSON | прямой ✅ (но c rate-limit) |
| **НКР** | `https://ratings.ru/api/v1/issuers/` | JSON | прямой? |

API могут поменяться — **первый шаг любой ветки D**: сделать `curl`-разведку
с CF Worker IP, убедиться что не блочат.

## Схема D1

```sql
CREATE TABLE IF NOT EXISTS issuer_ratings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  inn          TEXT,
  agency       TEXT NOT NULL,        -- 'ACRA' | 'EXPERTRA' | 'NKR' | 'NCR' | 'MOODYS' | 'SP'
  rating       TEXT NOT NULL,        -- 'AAA(RU)' | 'BB+' | 'D' | etc.
  outlook      TEXT,                 -- 'positive' | 'stable' | 'negative' | 'developing' | null
  action_type  TEXT NOT NULL,        -- 'assigned' | 'affirmed' | 'upgraded' | 'downgraded' |
                                     -- 'placed_under_review' | 'withdrawn' | 'confirmed'
  action_date  TEXT NOT NULL,        -- YYYY-MM-DD
  prev_rating  TEXT,                 -- предыдущий рейтинг (если есть)
  rationale    TEXT,                 -- краткая выписка из релиза
  source_url   TEXT,
  fetched_at   TEXT NOT NULL,
  UNIQUE (inn, agency, action_date, action_type) ON CONFLICT IGNORE
);
CREATE INDEX IF NOT EXISTS idx_ratings_inn ON issuer_ratings(inn);
CREATE INDEX IF NOT EXISTS idx_ratings_agency ON issuer_ratings(agency);
CREATE INDEX IF NOT EXISTS idx_ratings_date ON issuer_ratings(action_date);

-- «Текущий» рейтинг — view или денормализованная таблица
CREATE TABLE IF NOT EXISTS issuer_rating_current (
  inn          TEXT NOT NULL,
  agency       TEXT NOT NULL,
  rating       TEXT NOT NULL,
  outlook      TEXT,
  as_of        TEXT NOT NULL,
  PRIMARY KEY (inn, agency)
);
```

## Endpoints

- `POST /collect/ratings/acra?limit=200` — обход АКРА API.
- `POST /collect/ratings/expertra?limit=200`
- `POST /collect/ratings/nkr?limit=200`
- `POST /collect/ratings/all` — последовательный вызов всех трёх (cron).
- `GET /issuer/{inn}/ratings` — все рейтинги эмитента + история.
- `GET /ratings/recent?days=30` — лента действий за период.
- `GET /ratings/scale_diff?inn=X` — расхождение между рейтингами разных
  агентств (для эмитента с тремя оценками — спорные случаи).

## Маппинг ИНН

Главная сложность — у АКРА/Эксперт-РА/НКР рейтинги привязаны к
**своему internal id эмитента**, не к ИНН. Маппинг:

1. Сначала забираем список эмитентов с агентского API — там обычно
   есть `inn` либо `ogrn`.
2. Если ИНН нет — fuzzy-match имени против `issuers` (через
   `LOWER(REPLACE(name, ...)) LIKE '%ХХХ%'` или Cerebras-classifier
   "к какому из этих 1136 имён подходит «X»"). Лучше первое.
3. Если совсем непонятно — пишем без `inn`, помечаем
   `issuer_ratings.inn = NULL` и потом разрешаем вручную через UI.

## Шкалы рейтингов

Для default predictor (TRACK F) полезно нормализовать в числовую шкалу:

```
AAA → 21,  AA+ → 20, AA → 19, AA- → 18,
A+ → 17,   A → 16,   A- → 15,
BBB+ → 14, BBB → 13, BBB- → 12,
BB+ → 11,  BB → 10,  BB- → 9,
B+ → 8,    B → 7,    B- → 6,
CCC+ → 5,  CCC → 4,  CCC- → 3,
CC → 2,    C → 1,    D → 0
```

Российская шкала с суффиксом `(RU)` — та же, плюс корректировка на
suffix (`(RU)` ≈ international с поправкой -2-3 ступени из-за
страновой шкалы).

## Acceptance criteria

- [ ] `collect/ratings/all` за один прогон собирает 100+ действий
  на 50+ ИНН.
- [ ] `GET /issuer/{inn}/ratings` для крупного эмитента (например
  ИНН 7728168971 — Россети) показывает текущие рейтинги от всех
  трёх агентств.
- [ ] `issuer_rating_current` отражает последнее действие.
- [ ] В `/status`: `ratings_count`, `ratings_issuers_covered`.

## Что не делать

- Не пытаться добывать рейтинги Moody's / S&P / Fitch — они под
  санкциями и для РФ-эмитентов либо отозваны, либо неактуальны.
- Не парсить рейтинги из новостей через LLM — у агентств API
  достаточно надёжное.
