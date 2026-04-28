# TRACK B — Макро-индикаторы

## Цель

Подкачать ежедневно/еженедельно ряд макроэкономических показателей,
которые объясняют контекст для облигаций и акций РФ. Без них стресс-индекс
эмитента (TRACK E) бессмысленен.

## Источники (все бесплатные, доступ есть)

| Серия | Источник | Endpoint | Частота |
|---|---|---|---|
| Ключевая ставка ЦБ РФ | `cbr.ru/dataservice` | `/api/CursDynamic` | ежедневно |
| Инфляция (ИПЦ м/м, г/г) | `cbr.ru/Content/Document/File` (Excel) | прямой XLSX | ежемесячно |
| USD/RUB официальный | `cbr.ru/scripts/XML_dynamic.asp` | XML | ежедневно |
| Brent crude | `query1.finance.yahoo.com/v7/finance/download/BZ=F` | CSV | ежедневно |
| Gold | то же `GC=F` | CSV | ежедневно |
| S&P 500 | то же `^GSPC` | CSV | ежедневно |
| MOEX index | `iss.moex.com/iss/engines/stock/markets/index/securities/IMOEX/candles.json` | JSON | ежедневно |
| RUB index (DXY) | `query1.finance.yahoo.com/v7/finance/download/DX-Y.NYB` | CSV | ежедневно |
| US 10Y yield | `query1.finance.yahoo.com/v7/finance/download/^TNX` | CSV | ежедневно |
| ECB main rate | `data-api.ecb.europa.eu/service/data/...` | SDMX-JSON | ежемесячно |

Прокси через **`cf-worker.js`** (он уже задеплоен у пользователя как
`bondan-girbo.<account>.workers.dev`) — все эти домены в нём в allow-list.
Передаём URL в `?u=...`. Пользователь не должен снова деплоить —
проверить адрес можно в `bondan_girbo_proxy` в localStorage админки.

## Схема D1

```sql
CREATE TABLE IF NOT EXISTS macro_indicators (
  series_id   TEXT NOT NULL,        -- 'cbr_key_rate' | 'usd_rub' | 'brent' | ...
  date        TEXT NOT NULL,        -- YYYY-MM-DD
  value       REAL NOT NULL,
  unit        TEXT,                 -- '%' | 'RUB' | 'USD/bbl' | 'pts'
  source      TEXT,                 -- 'cbr' | 'yahoo' | 'ecb' | 'moex'
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (series_id, date)
);
CREATE INDEX IF NOT EXISTS idx_macro_series ON macro_indicators(series_id);
CREATE INDEX IF NOT EXISTS idx_macro_date ON macro_indicators(date);

-- Метаданные серий
CREATE TABLE IF NOT EXISTS macro_series_meta (
  series_id   TEXT PRIMARY KEY,
  name        TEXT,                 -- 'Ключевая ставка ЦБ РФ'
  unit        TEXT,
  frequency   TEXT,                 -- 'daily' | 'monthly'
  source      TEXT,
  source_url  TEXT,
  updated_at  TEXT
);
```

Seed `macro_series_meta` сразу 10-15 строк — это конфиг для
`collectMacro` коллектора.

## Endpoints

- `POST /collect/macro?series=key_rate,usd_rub,brent` — выборочный
  сбор. По умолчанию собирает все из `macro_series_meta`.
- `GET /macro/latest` — последние значения всех серий.
- `GET /macro/series?id=key_rate&from=2020-01-01` — временной ряд.
- `GET /macro/changes?window=30d` — z-score изменений за 30 дней
  (для визуализации «что больше всего сместилось»).

## Парсеры

**ЦБ РФ ставка** (`cbr.ru/dataservice/api`): JSON, поле `Rate`. Минимум.

**ЦБ РФ курс** (`cbr.ru/scripts/XML_dynamic.asp?date_req1=...&date_req2=...&VAL_NM_RQ=R01235`):
XML, `<Record><Value>...</Value></Record>` где value через запятую (`75,3214`).

**Yahoo Finance CSV**: первая строка — заголовок, потом
`Date,Open,High,Low,Close,Adj Close,Volume`. Для нас обычно важен
`Close`.

```js
function parseYahooCsv(text){
  const lines = text.trim().split('\n');
  const out = [];
  for(let i = 1; i < lines.length; i++){
    const parts = lines[i].split(',');
    if(parts.length < 5) continue;
    const date = parts[0];
    const close = parseFloat(parts[4]);
    if(isFinite(close)) out.push({date, value: close});
  }
  return out;
}
```

## Subrequest budget

10-15 серий × 1 fetch = 10-15 subrequest на cron. Очень дёшево.
Можно добавить в общий ежедневный cron (не отдельный).

## Acceptance criteria

- [ ] Один cron-запуск пишет 10+ серий в `macro_indicators`.
- [ ] `GET /macro/latest` отдаёт массив с key_rate, usd_rub, brent,
  imoex, sp500.
- [ ] У каждой серии в `/status` появляется `macro_*_lastdate` с
  указанием актуальности (не старше 7 дней для daily).
- [ ] Доступ через `cf-worker.js` прокси работает (Yahoo/ECB иначе
  не доступны из РФ).

## Что не делать

- Не пытаться парсить инфляцию из Excel (ЦБ опубликует сам, проще
  взять с `tradingeconomics.com` или ввести руками раз в месяц).
- Не строить корреляции с эмитентами (это TRACK E).
