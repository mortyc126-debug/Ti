# TRACK H — Банковская отчётность ЦБ (формы 101/102)

## Цель

У нас в `issuers.kind = 'bank'` сейчас 107 эмитентов, и для них
**нет вообще никакой отчётности** — buxbalans/ГИР БО банки не индексируют,
потому что они отчитываются в ЦБ по 86-ФЗ (формы 101/102), а не в
ФНС по 402-ФЗ.

Эта ветка добавляет коллектор для месячной отчётности банков с
**`cbr.ru/banking_sector/credit/coinfo/{license}/`**.

## Источник

ЦБ РФ публикует ежемесячно по каждому действующему банку:
- **Форма 101** (баланс): `/coinfo/{license}/F101.json`
- **Форма 102** (P&L): `/coinfo/{license}/F102.json`
- **Форма 134** (нормативы): `/coinfo/{license}/F134.json`

Лицензия (license) — 4-значный номер. Маппинг ИНН ↔ license нужен
отдельный — берётся из `cbr.ru/eng/registries/...` или из реестра
кредитных организаций.

## Схема D1

```sql
-- Маппинг ИНН → лицензия ЦБ
CREATE TABLE IF NOT EXISTS bank_licenses (
  inn          TEXT PRIMARY KEY,
  license      TEXT NOT NULL,         -- 4-значный номер
  reg_number   TEXT,
  short_name   TEXT,
  status       TEXT,                  -- ACTIVE | LICENSE_REVOKED
  reg_date     TEXT,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_banklic_license ON bank_licenses(license);

-- Месячные показатели банка (форма 101 + 102 + 134)
CREATE TABLE IF NOT EXISTS bank_monthly_reports (
  inn            TEXT NOT NULL,
  date           TEXT NOT NULL,        -- YYYY-MM-01 (первое число месяца)
  -- Баланс (форма 101) — основные строки в млрд ₽
  assets_total       REAL,             -- 5500
  loans_corp         REAL,             -- 4515 (кредиты юрлицам)
  loans_retail       REAL,             -- 4520 (кредиты физлицам)
  loans_overdue      REAL,             -- просроченные кредиты
  deposits_corp      REAL,             -- 4400 (счета юрлиц)
  deposits_retail    REAL,             -- 4232 (вклады физлиц)
  capital            REAL,             -- 5300 (собственный капитал)
  -- P&L (форма 102) — за месяц
  net_interest_income REAL,            -- 11500
  fee_income          REAL,
  trading_income      REAL,
  net_profit          REAL,             -- ЧП за месяц
  -- Нормативы (форма 134)
  n1_capital_ratio    REAL,             -- норматив достаточности капитала
  n2_quick_liquidity  REAL,
  n3_current_liquidity REAL,
  n4_long_liquidity   REAL,
  -- Расчётные ratio
  npl_ratio           REAL,             -- loans_overdue / (loans_corp + loans_retail)
  cir                 REAL,             -- cost-to-income
  roe                 REAL,             -- net_profit / capital × 12 (annualized)
  -- Метаданные
  source              TEXT NOT NULL,    -- 'cbr_f101' | 'cbr_f102' | 'cbr_f134'
  raw_balance         TEXT,             -- сырой JSON баланса
  raw_pnl             TEXT,             -- сырой JSON P&L
  fetched_at          TEXT NOT NULL,
  PRIMARY KEY (inn, date)
);
CREATE INDEX IF NOT EXISTS idx_bankrep_inn ON bank_monthly_reports(inn);
CREATE INDEX IF NOT EXISTS idx_bankrep_date ON bank_monthly_reports(date);
CREATE INDEX IF NOT EXISTS idx_bankrep_npl ON bank_monthly_reports(npl_ratio);
```

## Endpoints

- `POST /collect/bank_licenses?limit=200` — обновить маппинг ИНН ↔
  license из cbr.ru registry. Запускается раз в месяц.
- `POST /collect/bank_reports?inn=X` — потянуть последние 12 месяцев
  для одного банка.
- `POST /collect/bank_reports?limit=20` — батчем по очереди банков
  (kind='bank' в issuers).
- `GET /issuer/{inn}/bank_reports` — все отчёты по банку.
- `GET /bank/leaderboard?metric=roe&dir=top&limit=20` — рейтинг банков.
- `GET /bank/{license}/health` — agg-метрики свежие (n1, npl, roe, lcr).

## Парсер ЦБ

Структура `F101.json` — JSON-объект где ключ = код строки баланса,
значение — массив значений по датам. Например `{"5500": [3540000, 3580000, ...]}`.

Все суммы в **тысячах рублей**, делим на 1e6 → млрд.

## Прокси через cf-worker.js

cbr.ru — российский домен, должен ходить с CF Worker без проблем
(пользователь ЦБ-API раньше дёргал через cf-worker.js, но фактически
прямой fetch тоже сработает с правильным User-Agent).

## Маппинг ИНН → license

Самый болезненный вопрос. Источники:
1. `cbr.ru/banking_sector/credit/registries` — XML/HTML реестр всех КО
   с ИНН + лицензия + статус. Парсится один раз, обновляется раз в
   месяц.
2. Фолбэк: для каждого ИНН в issuers с kind='bank' идём в
   `cbr.ru/banking_sector/credit/coinfo/?id={inn}` (если ЦБ принимает
   поиск по ИНН) и находим license через редирект.

## Acceptance criteria

- [ ] `bank_licenses` заполнена для 90+% из 107 банков.
- [ ] `collect/bank_reports` за один прогон тащит 5-10 банков ×
  12 мес = 60-120 отчётов.
- [ ] `GET /issuer/7707083893/bank_reports` (Сбербанк) возвращает
  12 месяцев с ненулевыми assets_total и net_profit.
- [ ] `npl_ratio`, `roe` и `n1_capital_ratio` вычисляются.
- [ ] В `/status`: `bank_reports_count`, `banks_with_reports`.

## Что не делать

- Не пытаться раскрыть структуру F102 на отдельные строки — это
  огромная иерархия (P&L по статьям). Берём только сводные показатели.
- Не парсить F134 нормативы все 22 норматива — N1, N2, N3, N4
  достаточно для оценки.
- Не делать стресс-тесты — пусть это будет логика TRACK E.
