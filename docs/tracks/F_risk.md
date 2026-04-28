# TRACK F — Default predictor / Risk Card

## Цель

Для конкретного эмитента собрать **risk card** — структурированный отчёт
о рисках на горизонте 12 месяцев. Использует все накопленные данные
(reports, events, ratings, stress, affiliations, macro) как контекст
и **Cerebras** для генерации обоснованной оценки.

## Зависимости

- TRACK C (events) — какие события уже были.
- TRACK D (ratings) — рейтинговая история.
- TRACK E (stress) — текущий стресс.
- Существующие issuer_reports, issuer_affiliations.

## Подход

Чистый ML-классификатор требует разметки и истории — этого нет.
Поэтому используем **Cerebras на структурированном входе**: даём
модели всё что знаем об эмитенте в виде JSON, и просим вернуть оценку
+ 3-5 ключевых факторов.

## Схема D1

```sql
CREATE TABLE IF NOT EXISTS risk_cards (
  inn               TEXT NOT NULL,
  generated_at      TEXT NOT NULL,
  horizon_months    INTEGER DEFAULT 12,
  -- Числовые оценки (из LLM)
  default_prob_pct  REAL,                 -- 0..100
  liquidity_score   REAL,                 -- 0..100 (выше = лучше)
  leverage_score    REAL,
  ops_score         REAL,                 -- операционная стабильность
  governance_score  REAL,                 -- качество корп. управления
  composite         REAL,                 -- общий 0..100, выше = безопаснее
  rating_implied    TEXT,                 -- какой рейтинг это скорее всего: AA/A/BBB/...
  -- Текстовое
  summary           TEXT,                 -- 2-3 предложения
  key_strengths     TEXT,                 -- JSON-массив строк
  key_risks         TEXT,                 -- JSON-массив строк
  red_flags         TEXT,                 -- JSON-массив (severity≥high)
  recommended_action TEXT,                -- 'avoid' | 'hold' | 'add' | 'reduce'
  -- Метаданные
  inputs_hash       TEXT,                 -- sha256 ввода — для кеширования
  llm_engine        TEXT,                 -- 'cerebras' | 'grok'
  llm_tokens_in     INTEGER,
  llm_tokens_out    INTEGER,
  PRIMARY KEY (inn, generated_at)
);
CREATE INDEX IF NOT EXISTS idx_risk_inn ON risk_cards(inn);
CREATE INDEX IF NOT EXISTS idx_risk_composite ON risk_cards(composite);
```

## Endpoints

- `POST /compute/risk_card?inn=X&engine=cerebras` — генерация одной
  risk card. Кеш 7 дней по `inputs_hash` (если ничего не поменялось,
  возвращаем из кеша).
- `POST /compute/risk_cards?limit=20` — батч на топ-N эмитентов
  с активными бумагами.
- `GET /issuer/{inn}/risk_card` — последняя сгенерированная карта.
- `GET /risk/leaderboard?dir=top_risk&limit=20` — самые рисковые.

## Промпт для Cerebras

```
Ты эксперт по кредитному анализу российских эмитентов облигаций.
Тебе дан JSON со всей известной информацией об эмитенте за последние
3 года. Дай численную оценку и обоснование.

ВВОД:
{
  "issuer": { name, inn, sector, kind, status },
  "rating": { acra, expertra, nkr },
  "reports": [{year, rev, ebitda, np, debt, cash, eq, roa, ros}, ...],
  "stress": { current, p30d_max, components },
  "events_recent_90d": [{date, type, severity, summary}, ...],
  "macro": { key_rate, usd_rub, brent, imoex },
  "cohort_medians": { ebitda_marg, net_debt_eq, current_ratio }
}

ВЕРНИ JSON:
{
  "default_prob_pct": число 0..100,
  "liquidity_score": число 0..100,
  "leverage_score": число 0..100,
  "ops_score": число 0..100,
  "governance_score": число 0..100,
  "composite": число 0..100,
  "rating_implied": "AAA|AA|A|BBB|BB|B|CCC|D",
  "summary": "2-3 предложения по-русски",
  "key_strengths": ["строка1", "строка2", "строка3"],
  "key_risks": ["...", "..."],
  "red_flags": ["..."],
  "recommended_action": "avoid|hold|add|reduce",
  "confidence": число 0..1
}

ПРАВИЛА:
- Числа на основании cohort_medians (ниже медианы по leverage = хуже).
- Свежие события critical/high → red_flags.
- Если status != 'ACTIVE' → recommended_action = 'avoid', composite < 30.
- Не выдумывай факты — только из ввода.
```

## Acceptance criteria

- [ ] `POST /compute/risk_card?inn=2460066195` за 5-15 секунд возвращает
  заполненную карту.
- [ ] Для уже посчитанной карты повторный вызов возвращает кеш
  (`cache_hit: true` в ответе).
- [ ] `risk_cards.composite` коррелирует с рейтинговой шкалой
  (Spearman > 0.5 на тестовом наборе из 50 ИНН).
- [ ] При status='BANKRUPT' composite < 30 у >90% случаев.
- [ ] В `/status`: `risk_cards_count`.

## Что не делать

- Не использовать Grok — он медленнее и дороже Cerebras на bulk
  classification. Grok оставляем для свежих новостей и SPV-discovery.
- Не строить точную ML-модель — данных не хватит для статзначимости.
- Не давать инвестиционных рекомендаций — `recommended_action` это
  «направление мысли», не сигнал к действию. UI должен это маркировать.
