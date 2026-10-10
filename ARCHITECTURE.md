# Архитектура репозитория `ti`

Карта проекта: что из чего состоит, кто с кем общается и где лежат «хитрые места».
Документ описательный — это снимок на момент написания, не ТЗ.

> TL;DR. Это **не одно приложение, а экосистема из 5 систем**, выросших одна из
> другой. Их держат вместе не общие вызовы, а **общие данные** (кэши, БД,
> localStorage, буфер обмена). Источник правды пользовательских данных — **браузер**,
> а не сервер. Серверный слой — набор мелких независимых serverless-функций
> (ускорители/прокси/архив), каждый можно уронить по отдельности.

---

## 1. Пять систем и как они появились

Хронология (как оно росло):

1. **Расширение №1 — сбор отчётности** (`extension/`). Самое старое. Браузерное
   расширение, тянет существенные факты и аффилиации с `e-disclosure.ru` в обход
   антибота. Было ещё до бота.
2. **Фундаментал для ручного анализа** — старые одностраничные HTML (`index.html`,
   `analysiscompany.html`, `debt_v10.html`, `Долг__нагрузка*.html`, …) →
   переросли в **веб-приложение** `web/` (React/Vite). Контекст фундаментала «на
   себя», не для автоматики.
3. **Лаборатории методов** — HTML-песочницы (`indlab_v10 (1).html`,
   `oi-signal-v*.html`, `oi_lab.html`, `channels_lab.html`, …) для ручной проверки
   теханализа независимо от бота.
4. **Бот — автономная торговая система** (`invest-bot/`). Куча видов теханализа,
   бэктесты на архиве свечей, калибровки, дашборд.
5. **Расширение №2 — мод терминала** (`tv-signals-extension/` + вспомогательная
   рисовалка `chart-draw-extension/`). Лучшие методы, прошедшие испытания, рисуются
   прямо на графике Тинькофф/TradingView.

```
Фундаментал (ручное):   web/ + старые *.html + backend/              ← система A
Сбор данных (браузер):  extension/ (раскрытия)                       ← система B (расш. №1)
Исследование методов:   корневые *lab*.html ──INDICATOR_REGISTRY──┐
Автоторговля:           invest-bot/ (+ cf-collector) ───────────────┤  ← система C (бот)
Мод терминала:          tv-signals-extension/ + chart-draw ─signals-core┘ ← система D (расш. №2)
```

Соединительная ткань:
- **`signals-core.js`** — общий «движок методов». Живёт в ДВУХ копиях:
  `tv-signals-extension/signals-core.js` и `invest-bot/run_signals_core.js`.
  Синхронизируются **вручную** через `INDICATOR_REGISTRY.md`.
- **`INDICATOR_REGISTRY.md`** — единый чек-лист «indlab ↔ стратегия бота»
  (`oi_composite_strategy.py`), правила кросс-переноса формул.
- **`formulas/`** — референс-реализации математики (Hurst, Hawkes, EMD, EVT, SOC, DFA…).
- **Архив свечей + кэши** — на чём гоняются бэктесты.

---

## 2. Веб-приложение (`web/`)

React (Vite) + **два встроенных модуля-iframe**. Приложение не выходит за пределы `web/`.

```
web/
├─ public/modules/
│  ├─ debtload.html          «ДОЛГ»: ВСЕ расчёты долговой нагрузки (~178 КБ)
│  └─ analysiscompany.html   «ОТЧЁТНОСТЬ»: разбор эмитентов, банк-модель,
│                            сравнение, аудит (~2 МБ — самый большой файл)
├─ public/industry-peers.json  каталог отраслей + ИНН-peer'ы
└─ src/
   ├─ App.jsx                роутинг (разделы)
   ├─ pages/                 одна страница = один раздел:
   │                         Home · Bonds · Stocks · Market(Карта) · Industries(Отрасли)
   │                         Portfolio · Favorites · Live · Reports→iframe · DebtLoad→iframe
   │                         Spreads («КС / спреды к ОФЗ»)
   ├─ lib/                   чистые вычисления (spreadsOfz, bondization, valuation,
   │                         metrics, mscore, norms, scenario, comparisonSet, …)
   ├─ store/                 zustand-сторы (rates, portfolio, issuers, marketData,
   │                         comparison, industryNorms, windows, news, …)
   ├─ data/                  источники+моки (tinvest, marketReal, issuersReal,
   │                         industries, comparisonMetrics, *Mock)
   └─ components/            ui/ · industries/ · market/ · bonds/
```

Вычисления «Долг» и «Отчётность» — **в отдельных HTML-модулях** (у каждого свой JS
внутри), React-страницы `DebtLoad.jsx`/`Reports.jsx` просто вставляют их как iframe.
Оба модуля лежат **внутри** `web/public/modules/`, наружу приложение не ходит.

### Зависимости веба (npm)
Нужные: `react`, `react-dom`, `react-router-dom`, `zustand`, `recharts`,
`lucide-react`, `react-rnd` (мини-окна), `fuse.js` (поиск). Сборка: `vite`,
`tailwindcss`, `postcss`, `autoprefixer`.
**Мёртвый груз (объявлены, не импортируются):** `lightweight-charts`, `reactflow` —
можно удалить.

### Библиотеки в модулях (CDN, не npm)
`SheetJS/xlsx` (чтение XLSX ФНС/smart-lab), `pdf.js` (PDF-отчёты), `mammoth` (DOCX),
`Chart.js` (графики в «Долге»). Хосты: cdnjs, jsdelivr.

---

## 3. Бот (`invest-bot/`)

~46k строк Python, ~130 файлов. Отдельный процесс, свой токен, свой облачный архив.

**Точки входа:** `main.py` (сам бот, asyncio), `bot_supervisor.py` (старт/стоп через
subprocess + PID-файл), `dashboard.py` (~10k строк, панель на голом `http.server`),
`run_pipeline.py` (сквозной прогон калибровок).

**Стратегийный контракт** (`trade_system/`):
- `strategies/base_strategy.py` — абстрактный `IStrategy`: `analyze_candles(candles)
  → Signal|None`, `settings`, `update_lot_count`, `update_short_status`;
- `signal.py` — `Signal{figi, signal_type(LONG/SHORT/CLOSE), take_profit, stop_loss,
  entry_price}`;
- `strategies/strategy_factory.py` — имя-строка из конфига → класс;
- стратегии: `oi_composite` (10 988 строк — флагман), `hierarchical`, `level_pattern`,
  `level_reaction`, `accel_fade`, `nw_memory`, `nw_global`, `channel_level_fut`.
- `configuration/settings.py::StrategySettings` — на тикер; `settings: dict` —
  свободные параметры, стратегия парсит сама (ядро не зависит от их состава).

**Исполнение** (`trading/`): `trader.py` (ордера/стопы), `trade_service.py`
(расписание дня), `trade_results.py`.

**Телеграм/блог:** `tg_api/`, `blog/`. **Фреймворк только один** — `aiogram`.
Остальное: `tinkoff-investments` (gRPC SDK), `cerebras_cloud_sdk`, `numpy`/`scipy`/
`scikit-learn`, `matplotlib`. Веб-фреймворка нет — дашборд на stdlib `http.server`.

### Отсечение данных при тестировании методов (анти-переобучение)
Ядро — `method_calibrator.py` (подбор параметров под тикер) и `walk_forward.py`
(стабильность во времени):
- **walk-forward фолды**: in-sample `[start, bound)` — подбор; OOS `[bound, test_hi)`
  — проверка на невиданном блоке;
- **эмбарго на горизонт H**: окно отбора обрезается на H баров до границы
  (`hi = bound − H`), т.к. исход сигнала = `close[i+H]` — иначе train залезает в test;
- **каузальность**: `hi = min(hi, n − horizon)`, ATR-стоп по окну до сигнала;
- **метрика** — expectancy (знаковый ход, взвешенный по размеру, минус издержки, со
  стопом 1.5·ATR), не hit-rate;
- **гейт** — нижняя доверит. граница OOS-эффекта > 0 (Z=1.6), парно > классики, порог
  в долях σ инструмента, согласованность ≥75% фолдов;
- **усадка (shrinkage)** к «классическим» параметрам пропорционально силе OOS-эффекта;
- **плацебо**: пороги калиброваны по random-walk (ложная адаптация ~0%);
- `walk_forward.py` классифицирует методы по времени: stable / drift / noise (+ по
  режимам рынка). В расширение №2 едут только **stable**;
- фундаментал (PEAD): отсечение по `available_at` (конец дня раскрытия) — не торговать
  до публикации.

---

## 4. Расширения (браузерные, MV3)

| Папка | Что | Ключевое техническое |
|---|---|---|
| `extension/` | Сбор раскрытий с e-disclosure | приватный API + ASP.NET antiforgery (кука + `RequestVerificationToken`), fallback «жми Искать пока не сработает», обмен с вебом **через буфер обмена** (base64 PDF), ZIP распаковывается in-memory |
| `tv-signals-extension/` | Сигналы на графике терминала | MAIN-мир → `iframe.contentWindow.tradingViewApi` → `exportData()`; рисует нативными `createShape`; CORS-обход через мост MAIN→DOM-событие→isolated→`chrome.runtime`→SW; MOEX futoi по сессионной куке; `agree_scan.js` гоняет тот же core офлайн по `candle_cache` |
| `chart-draw-extension/` | Ручная разметка графика | слой рисования (уровни/линии/каналы), координаты экранные (не якорятся к цене), localStorage по ключу страница+тикер |

Логически №2 и рисовалка — один «мод терминала»; в коде это **два отдельных
расширения** (два `manifest.json`), не слиты.

---

## 5. Серверный слой (5 кусков, 2 облака)

Ни один не обязателен: веб/бот деградируют на прямой доступ (MOEX/T-Invest) и моки.

### A. `backend/` — главный бэкенд (Cloudflare Worker + D1 `coldline`)
- Entry: `export default { fetch, scheduled }`; cron `30 7 * * *` (10:30 МСК).
- **GET (публичные):** `/status`, `/stock/latest|history`, `/futures/latest`, `/basis`,
  `/basis/history`, `/bond/latest|history|issuer`, `/catalog`, `/reports/latest`,
  `/analysis/credit_pead`, `/issuers/report_years`, `/issuer/:inn` (+`/reports|/bonds|
  /affiliations`), `/diag/*`.
- **POST (требуют `X-Admin-Token`):** `/collect/{stock,futures,bonds,issuers,reports,
  affiliations}`, `/ai/extract`.
- **D1 (11 таблиц):** `stock_daily`, `futures_daily`, `bond_daily` (главная),
  `issuers` (единая точка истины ИНН↔имя↔тикер↔сектор↔ОКВЭД↔kind), `issuer_securities`,
  `issuer_reports` (РСБУ в млрд ₽), `reports_queue`, `ai_cache`, `ai_calls_log`,
  `issuer_affiliations` (ЕГРЮЛ/DaData), `collection_log`.
- **Источники:** MOEX ISS, ГИР БО (каскад → buxbalans), DaData, Cerebras/Grok.
- Гео-проблема: CF вне РФ → ФНС режет (522) → `env.GIRBO_PROXY` ходит через РФ-прокси (C).

### B. `cf-worker.js` (корень) — CORS-прокси для веба (Cloudflare Worker)
Пересылает GET на `bo.nalog.gov.ru` и `cbr.ru/dataservice`, добавляет CORS.
Протокол `?u=<url>`. Нужен, т.к. ФНС/ЦБ не отдают CORS браузеру. Дефолт — публичный
`corsproxy.io`.

### C. `yandex-cloud-proxy.js` + `yandex-api-gateway.yaml` — РФ-прокси (Yandex Function + API Gateway)
Тот же `?u=`, но на российском IP (ФНС/audit-it/buxbalans/ЕГРЮЛ/e-disclosure/ЦБ
пускают). Прикидывается Chrome (полный набор `Sec-*`, Referer), POST для ЕГРЮЛ,
проброс `Set-Cookie`, бинарь как base64, retry на 5xx/522. Это тот самый `GIRBO_PROXY`.

### D. `invest-bot/cf-collector/` — архив бота (Cloudflare Worker + D1 `invest-bot-archive`)
Auth `X-API-Key`. Таблицы: `snapshots`, `trades`, `candles`. Пишет
`collector_worker.py`, читает `trader.py`. Логика композита — в Python, тут хранение.

### E. `yc-backup/` — холодный резерв (Yandex Function + YDB)
Зеркало маршрутов на YDB вместо D1 — на случай отказа Cloudflare.

### Кто куда ходит
```
ВЕБ (ручной)
 ├─ REST → backend A (вселенная бумаг, карточки эмитентов, basis)
 └─ прокси → cf-worker B / yandex C → ГИР БО / ЦБ (из браузера)
backend A (cron) → MOEX / ГИР БО (через yandex C) → buxbalans / DaData / Cerebras → D1 coldline
БОТ (python) → cf-collector D (свой архив) ; торгует через T-Invest напрямую
yc-backup E — холодный резерв (YDB)
```

### Деплой и секреты
- **Cloudflare:** Pages (`web/dist`) + 3 Worker’а (A, B, D) + 2 D1 (`coldline`,
  `invest-bot-archive`).
- **Yandex Cloud:** Function+Gateway (C), Function+YDB (E).
- **Секреты только через `wrangler secret`/env** (НЕ в репо): `ADMIN_TOKEN`, `API_KEY`,
  ключи Cerebras/Grok, DaData. В `wrangler.toml` — лишь `database_id` и публичный `MOEX_BASE`.
- ⚠️ `invest-bot/settings.ini` содержит **реальные токены** (T-Invest/Telegram) — не светить
  при переносе репо; проверить, не закоммичен ли.

---

## 6. Хранение и обмен данными (важно!)

- **Источник правды пользовательских данных — браузер**: `reportsDB` в IndexedDB
  (`bondan_store`), зеркало/настройки в `localStorage` (`ba_v2`, `debt_kc_hist_v1`,
  токены). Бэкенд — кэш/накопитель, не source of truth. Потеря профиля браузера =
  потеря базы → есть кнопка «💾 Бэкап» и тройная синхронизация.
- **Межкомпонентный обмен:** общие ключи `localStorage` (React ↔ iframe-модули),
  `BroadcastChannel('bondan-sync')`, перечитывание на `focus`.
- **Синхронизация устройств (3 пути):** jsonblob.com (AES-256-GCM), GitHub Gist,
  офлайн-код (gzip+base64) + QR (qrserver) для переноса кода.
- **Бот ↔ анализ:** `walk_forward.py` запускает `score_methods.py` как **subprocess** и
  читает CSV; дашборд ↔ `main.py` — через PID-файл + `bot_overrides.json` (опрос на
  каждой свече). Контракт = файлы.

---

## 7. ⚠️ Хитрые места / тех-долг (чтобы не удивляться потом)

- **Переопределён `document.getElementById`** (`analysiscompany.html`): на несуществующий
  id возвращается dummy-элемент, чтобы код не падал на null. Источник класса багов
  вида «x.remove is not a function».
- **`build:standalone`**: Vite бандлит → скрипт инлайнит обратно в один
  `bondan-standalone.html` (открыть приложение одним файлом без сервера).
- **`_tinkoff_stub/`**: поддельный `tinkoff`/`grpc` (только `StatusCode`), чтобы офлайн-
  скрипты импортировались без SDK; на боевой машине реальный пакет затеняет стаб.
- **Движок методов в двух копиях** (`signals-core.js` ↔ `run_signals_core.js`),
  синхрон вручную через `INDICATOR_REGISTRY.md` — возможен рассинхрон.
- **Фундаментал-каскад** ГИР БО → buxbalans → **LLM с веб-поиском** (`/ai/extract`):
  если данных нет по API, их «догугливает» модель.
- **Две D1 и два прокси** (backend vs cf-collector; cf-worker vs yandex) — не единая
  система, а параллельные независимые.
- **Мёртвые npm-зависимости** веба: `lightweight-charts`, `reactflow`.
- **Версионирование файлами** в корне: `index (4).html`, `Долг__нагрузка (28).html` — git
  + суффиксы из «Загрузок».

---

## 8. Куда что добавлять

| Задача | Место |
|---|---|
| Новый раздел веба | `web/src/pages/X.jsx` + роут в `App.jsx` + пункт `AppSidebar.jsx` |
| Чистое вычисление для веба | `web/src/lib/` |
| Новая метрика сравнения | `web/src/data/comparisonMetrics.js` (+ радар) |
| Правка «Долга»/«Отчётности» | `web/public/modules/debtload.html` / `analysiscompany.html` |
| Новая стратегия бота | `invest-bot/trade_system/strategies/` + `strategy_factory.py` |
| Новый индикатор/метод | `signals-core.js` (×2) + `INDICATOR_REGISTRY.md` |
| Новый серверный endpoint | `backend/worker.js` (+ `schema.sql` при новой таблице) |
| Новый источник данных | прокси C/B (добавить домен в whitelist) |
