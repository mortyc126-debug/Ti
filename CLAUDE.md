# CLAUDE.md — контекст проекта «БондАналитик»

Этот файл читается Claude Code в начале каждой сессии. Здесь — самое
важное, что нужно знать, чтобы быстро включиться в работу.

## Что это за проект

Один статический `index.html` (~11k строк) — SPA для анализа российских
корпоративных облигаций и финансовой отчётности эмитентов. Всё в одном
файле: HTML, CSS и JavaScript. Нет бандлера, нет фреймворка, нет npm.
Работает напрямую из браузера, данные — в `localStorage`.

Пользовательница — русскоязычная, ведёт свой портфель ВДО и анализирует
отчётность эмитентов. Общение в сессиях — **по-русски**.

Деплой: GitHub репозиторий `mortyc126-debug/ti`, превью через
`raw.githack.com` или `rawcdn.githack.com`.

## Где что лежит

```
/index.html                       — вся логика проекта
/cf-worker.js                     — Cloudflare Worker-прокси для ГИР БО
/references/
  /index.json                     — каталог эталонов (общий seed)
  /industry-peers.json            — 15 отраслей + ИНН-peer'ы
  /issuers/*.json                 — JSON'ы для ручного импорта эмитентов
/REVIEW.md                        — старый документ ревью
/CLAUDE.md                        — этот файл
```

Ветка разработки: **`claude/add-rosstat-ratios-WzAsa`** (всё пушится сюда).

## Ключевые структуры в памяти (localStorage)

| Ключ                              | Содержимое                                    |
|-----------------------------------|-----------------------------------------------|
| `ba_v2`                           | `{ytmBonds, portfolio, watchlists, calEvents, reportsDB}` |
| `bondan_refs`                     | Сохранённые эталоны РСБУ для сверки           |
| `bondan_industry_peers`           | Правки пользователя к `industry-peers.json`   |
| `bondan_industry_medians`         | Посчитанные медианы p25/p50/p75 по отраслям   |
| `bondan_rosstat_ratios`           | `{year: {normName: {name, ros, roa, rosNeg, roaNeg}}}` — данные ФНС |
| `bondan_girbo_proxy`              | URL прокси для ГИР БО (Cloudflare Worker)     |
| `ba_apikey`                       | AI API-ключ                                    |
| `ba_sync_code`                    | Код синхронизации (UUID:base64key)             |
| `ba_gist_id`, `ba_gist_token`     | GitHub Gist                                    |

`reportsDB = {issuerId: {name, ind, periods: {periodKey: {year, period, type, rev, ebitda, ebit, np, int, tax, assets, ca, cl, debt, cash, ret, eq, ...}}}}`.

**Внутренняя единица везде — млрд ₽**. При парсинге/импорте всё приводится
к млрд. Короткие ключи метрик: `rev, ebitda, ebit, np, int, tax, assets,
ca, cl, debt, cash, ret, eq`. Маппинг «короткий → форм-id» в константе
`_REPORTS_FIELD_MAP` (коротких 12, форм-id вида `rep-np-rev`).

`periodKey = ${year}_${period}_${type}`, где period ∈ `{Год, 9М,
Полугодие, 3 квартал, 1 квартал}`, type ∈ `{МСФО, РСБУ}`.

## Страницы приложения

1. **📊 YTM** — расчёт эффективной доходности облигаций.
2. **💼 Портфель** — P&L, безубыток.
3. **⭐ Списки** — watchlist'ы.
4. **💰 P&L / Безубыток**.
5. **🏢 Эмитент** — анализ эмитента (старый модуль).
6. **📅 Календарь** — купоны, оферты, события.
7. **📂 Отчётность** — `reportsDB`, распознавание отчётов (PDF/DOCX/XLSX),
   ручной подбор, сверка с эталоном + ФНС, аудит.
8. **🏭 Отрасли / медианы** — база ИНН по 15 секторам, расчёт медиан
   через ГИР БО, импорт XLSX ФНС (ROS/ROA по ОКВЭД).
9. **📊 Сравнение компаний** — радар / heatmap / бар-чарт по всем
   эмитентам reportsDB.

## Синхронизация между устройствами

Три пути, один общий snapshot-билдер `_syncBuildSnapshot` и applier
`_applyIndustryFromSnapshot`:

1. **Код синхронизации** (AES-256-GCM + jsonblob.com) — `syncMakeCode/
   syncCloudSave/syncCloudLoad`.
2. **GitHub Gist**.
3. **Офлайн-код** (gzip+base64, без сети).

Payload: `{ytmBonds, portfolio, watchlists, calEvents, reportsDB, refs,
industryPeers, industryMedians, rosstatRatios, girboProxy, apiKey,
meta:{schemaVersion:5}, savedAt}`.

**Всегда бампать `schemaVersion` при добавлении новых полей** и
править оба: `_syncBuildSnapshot` и `_applyIndustryFromSnapshot`.

## Важные функциональные модули

### Парсер отчётов (📂 Отчётность)
- `repParseFile` → PDF (pdfjs + OCR fallback) / DOCX (mammoth) / XLSX (SheetJS).
- `repPickerRenderSuggestions` — ручной подбор значений, использует
  `REP_PICKER_FIELDS[].hint` (regex-синонимы).
- Fallback: если hint не дал совпадений, показывает топ-30 крупнейших
  чисел из текста.

### Сверка с эталоном
- `_seriesFromReportsDB` — собирает многопериодную series из reportsDB
  по совпадению orgName.
- `repRenderRefResult` — матрица показатель×период + sparkline + колонка
  «отрасль p50» + блок «🇷🇺 Сравнение с ФНС/Росстат».
- `_rosstatCompareBlock` — подтягивает ROS/ROA ФНС для отрасли эмитента.

### ФНС / Росстат
- `rosstatParseFnsXlsx(file)` — парсер XLSX ФНС.
- `_ROSSTAT_INDUSTRY_MAP` — 15 industry-key → строки ФНС.
- `rosstatLookup(industryKey, year)`.

### Сравнение компаний (радар/heatmap/bar)
- `_CROSS_RADAR_AXES` — 8 коэффициентов для радара.
- `_CROSS_PALETTE` — 30 HSL-цветов (шаг hue ≈12°, 3 слоя яркости).
- `_crossRanks` — перцентиль-ранжирование (0..100), для higher=false
  метрик инвертировано.
- `_crossCollectAll` — по одной записи на эмитента, дубли по scope
  схлопываются (берётся запись с max заполненных полей).

### Аудит данных
- `_REP_AUDIT_RULES` — 14 правил в двух категориях (🔴 hard / 🟡 soft).
- Толерантность 0.5% для балансовых проверок.
- Клик по строке → прыжок + сразу `repEditPeriod`.

### Редактирование периода
- `repNewPeriodModal()` — режим «новый» (сбрасывает `_repEditOldKey`).
- `repEditPeriod()` — режим «правка» (ставит `_repEditOldKey =
  repActivePeriodKey`, меняет заголовок, заполняет поля).
- `repSavePeriod()` — если ключ изменился, удаляет старую запись;
  применяет `_REP_UNIT_TO_BN[текущая единица]` для перевода в млрд.
- Переключатель единиц: `_repNpSetUnit('млн'|'млрд'|'трлн')` —
  пересчитывает поля на лету.
- Быстрые кнопки: `_repNpRescale(0.001|1000)` — ×/÷1000 без смены
  единицы (для исправления ранее введённого не в ту шкалу).

## Стиль и конвенции

### Код
- **Не** менять архитектуру (один файл). Просто добавлять функции.
- Комментарии — по-русски, объяснять **почему**, а не **что**.
- Не писать docstrings и multi-line JSDoc. Одна строка-другая.
- Без новых зависимостей (pdfjs, mammoth, xlsx — уже есть).

### Проверка синтаксиса
После любой правки `index.html`:
```bash
node -e "const t=require('fs').readFileSync('index.html','utf8'); const m=t.match(/<script>([\s\S]*?)<\/script>/g); const all=(m||[]).map(s=>s.replace(/^<script>|<\/script>$/g,'')).join('\n;\n'); new Function(all); console.log('OK')"
```
Должно выдавать `OK`. Если `SyntaxError` — ищи место.

### Git
- Ветка: `claude/add-rosstat-ratios-WzAsa`.
- Коммиты — **на русском, развёрнутые**, объясняют что и зачем. Пример
  в `git log`.
- После коммита — обязательный `git push -u origin claude/add-rosstat-ratios-WzAsa`.
- **Не** создавать PR'ы без явной просьбы.
- GitHub MCP доступен (scoped на `mortyc126-debug/ti`), но в большинстве
  задач нужен только `git push`.

### Общение с пользователем
- Стиль: **короткие, по делу**, без воды. Один абзац — одна мысль.
- Markdown ок: заголовки, списки, таблицы.
- **Важно:** между сообщениями и tool-вызовами НЕ должно быть долгих
  пауз. Если ответил текстом без действия — стрим рвётся с ошибкой
  `Stream idle timeout - partial response received`. Правило: каждая
  моя реплика либо короткое текстовое сообщение-update (≤25 слов), либо
  сразу tool_use. Не болтать во время «раздумий».
- Не рассказывать план действий — сразу делать.
- После сложной задачи — финальная сводка что сделано + ссылка (URL
  предпросмотра + коммит-хеш).

### URL для превью
- Свежий (CDN-кеш 5-10 мин):
  `https://raw.githack.com/mortyc126-debug/ti/claude/add-rosstat-ratios-WzAsa/index.html`
- На конкретный коммит (мгновенно, вечный кеш):
  `https://rawcdn.githack.com/mortyc126-debug/ti/<sha>/index.html`

## Что уже сделано в текущей ветке

Крупные фичи (в порядке добавления):

1. **Многопериодный эталон** — матрица показатель×год + sparkline.
2. **ГИР БО прокси** — автоматическая подтяжка 5 лет РСБУ по ИНН.
3. **Страница «Отрасли»** — 15 секторов, CRUD peer'ов, seed 20+ публичных.
4. **Медианы по отраслям** — через ГИР БО, p25/p50/p75, колонка в матрице.
5. **ФНС/Росстат ROS/ROA** — импорт XLSX, словарь 15 отраслей → ФНС,
   сверка в блоке эталона, `schemaVersion → 5`.
6. **Страница «Сравнение компаний»** — радар (8 осей, 30 цветов) +
   heatmap (все 15 метрик) + bar; переключатель вида; фильтр по имени;
   опция «только та же scope»; CSV-экспорт.
7. **Редактирование периода** — кнопки ✎/🗑 на toolbar, `repEditPeriod`,
   переименование ключа при смене года/периода/типа.
8. **🔍 Аудит данных** — 14 правил проверки консистентности.
9. **Переключатель единиц в форме периода** — млн/млрд/трлн + кнопки
   ÷1000/×1000 для быстрого исправления масштаба.
10. **Ручной подбор: расширены синонимы** во всех 12 полях + fallback
    «топ-30 крупнейших чисел» когда hint не дал совпадений.
11. **Мёрдж-импорт одного эмитента** (`repImportIssuerJson`) +
    `references/issuers/pgk.json` — 4 периода МСФО ПГК.

## Типичные задачи и где их делать

| Задача                                    | Файл/место                                  |
|-------------------------------------------|---------------------------------------------|
| Добавить поле в период                    | `_REPORTS_FIELD_MAP` + form HTML + `repSavePeriod` + `_syncBuildSnapshot` (bump schemaVersion) |
| Добавить синонимы распознавания           | `REP_PICKER_FIELDS[].hint`                  |
| Правило аудита                            | `_REP_AUDIT_RULES`                          |
| Новая метрика в радар/heatmap             | `_CROSS_METRICS` + (для радара) `_CROSS_RADAR_AXES` |
| Новая отрасль                             | `references/industry-peers.json` + `_ROSSTAT_INDUSTRY_MAP` |
| Новая страница                            | HTML `<div class="page" id="page-X">`, nav-btn, sb-item, роут в `showPage`, функция `XInit` |
| Парсер ещё одного формата отчёта ФНС      | по образцу `rosstatParseFnsXlsx`            |

## Чего не делать

- Не ломать существующие ключи `reportsDB` / `ba_v2` / sync payload без
  bump `schemaVersion` и миграции в `_applyIndustryFromSnapshot`.
- Не трогать стратегию хранения «всё в млрд внутри» — куча кода на это
  завязана (сравнение, ФНС-сверка, графики).
- Не создавать новых документаций, README, CHANGELOG — пользователь
  не просил.
- Не делать `git push --force`, `git reset --hard` без явной просьбы.
- Не писать emoji в код, кроме как в UI-строки/подписи кнопок (там они
  к месту — `🔴 🟡 ✓ 📊 🏭` и т.д.).
