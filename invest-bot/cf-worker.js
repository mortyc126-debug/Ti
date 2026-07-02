// Cloudflare Worker — CORS-прокси + D1 для OI·INTEL
//
// Binding: OI_DB → D1 database oi_signal1
//
// Маршруты /db/:
//   /db/init                          GET  — создать/обновить схему
//   /db/candles                       POST — upsert свечи
//   /db/candles?ticker=&tf=&from=     GET  — свечи после timestamp
//   /db/signal                        POST — новый сигнал
//   /db/signal/:id                    PATCH— обновить сигнал
//   /db/signals?ticker=&resolved=     GET  — список сигналов
//   /db/weight                        POST — upsert вес метода
//   /db/weights?ticker=               GET  — веса тикера
//   /db/algopack                      POST — upsert сырые бары AlgoPack
//   /db/algopack?ticker=&type=&from=  GET  — история баров
//   /db/percentiles                   POST — сохранить кэш перцентилей
//   /db/percentiles?ticker=&window=   GET  — загрузить кэш перцентилей
//   /db/atr                           POST — upsert ATR по тикеру
//   /db/atr?ticker=                   GET  — ATR тикера
//   /db/indverdict                    POST — сохранить вердикт модуля indlab
//   /db/indverdict?ticker=            GET  — последний сохранённый вердикт
//   /db/candles/tinvest?ticker=&figi=&from=&to= GET — бэкфилл дневных свечей из T-Invest → candles tf=day
//   /db/tickers                       GET  — список тикеров в oi_daily с кол-вом дней и диапазоном дат
//   /db/oidaily                       POST — upsert дневной снэпшок ОИ (юр/физ, лонг/шорт, цена)
//   /db/oidaily?ticker=               GET  — вся история снэпшотов тикера (для слоёв позиций)
//   /db/oibackfill?tickers=&days=     GET  — разовый backfill истории FutOI юр/физ за прошлые
//                                            даты (date= в futoi API); без tickers — берёт
//                                            текущий отслеживаемый список из oi_tracked_state.
//                                            Пишет и дневной итог в oi_daily, и ВСЕ внутри-
//                                            дневные снэпшоты даты (10-мин срезы) в oi_hourly
//   /db/oidaily/backfillprice?ticker= GET  — ретроактивно проставить price в oi_daily root-
//                                            тикера (там всегда 0): ищет все дескрипты серии
//                                            через T-Invest FindInstrument (не только уже
//                                            известные нам), тянет их дневные свечи, пишет
//                                            цену по датам, где нашлось совпадение
//   /db/instruments/assetclass?ticker=    GET  — класс актива ОДНОГО root-тикера (акция/валюта/
//                                            товар/индекс) через T-Invest FindInstrument+FutureBy
//
// Cron (scheduled): ежедневный автосбор oi_daily по всем ликвидным фьючерсам
// FORTS — без участия браузера. Настройка:
//   1. Cloudflare Dashboard → Workers → этот воркер → Settings → Variables →
//      добавить secret MOEX_KEY (тот же ключ, что в поле "MOEX API key" в приложении).
//   2. Settings → Triggers → Cron Triggers → добавить "0 22 * * *"
//      (22:00 UTC = 01:00 МСК — данные FutOI публикуются к 00:10-00:50 МСК,
//      этот час даёт запас).
// Список тикеров cron определяет сам: тянет /iss/engines/futures/markets/forts/
// securities.json (объём+ОИ+цена), ранжирует по объёму с гистерезисом
// (входит в отбор при топ-50% объёма, выпадает только ниже топ-80% —
// без гистерезиса контракты на границе порога дёргались бы то туда то сюда
// день ото дня) и ГАРАНТИРОВАННО включает текущий фронт-месяц по каждому
// базовому активу (BR, Si, RI, GZ...) независимо от объёма — иначе в момент
// роста объёма нового фронт-месяца при ролле он мог бы выпасть на пару дней.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  // Chrome Private Network Access: страницы с "public" адресов (raw.githack.com)
  // блокируют запросы к workers.dev (адресное пространство "unknown") без этого заголовка
  'Access-Control-Allow-Private-Network': 'true',
};

const DB = env => env.OI_DB;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── Schema ─────────────────────────────────────────────────────────────────
const SCHEMA_STMTS = [
  // Свечи T-Invest
  `CREATE TABLE IF NOT EXISTS candles (
    key    TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    tf     TEXT NOT NULL,
    time   INTEGER NOT NULL,
    o REAL, h REAL, l REAL, cl REAL, vol INTEGER DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_candles_ttf ON candles(ticker, tf, time)`,

  // Сигналы
  `CREATE TABLE IF NOT EXISTS signals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    ticker      TEXT NOT NULL,
    tf          TEXT NOT NULL,
    entry_price REAL DEFAULT 0,
    entry_ts    INTEGER DEFAULT 0,
    composite   REAL DEFAULT 0,
    dir         TEXT DEFAULT 'neutral',
    methods     TEXT DEFAULT '{}',
    mfe         REAL DEFAULT 0,
    mae         REAL DEFAULT 0,
    quality     REAL,
    resolved    INTEGER DEFAULT 0,
    resolved_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker, resolved)`,

  // Адаптивные веса методов
  `CREATE TABLE IF NOT EXISTS weights (
    key         TEXT PRIMARY KEY,
    ticker      TEXT NOT NULL,
    method_id   TEXT NOT NULL,
    weight      REAL DEFAULT 0.5,
    total       INTEGER DEFAULT 0,
    sum_quality REAL DEFAULT 0,
    updated_at  INTEGER DEFAULT 0
  )`,

  // Сырые бары AlgoPack (tradestats / obstats / orderstats / futoi)
  // Храним всё поле values как JSON — гибко, не нужно менять схему при добавлении полей
  `CREATE TABLE IF NOT EXISTS algopack (
    key        TEXT PRIMARY KEY,
    ticker     TEXT NOT NULL,
    type       TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    tradedate  TEXT,
    tradetime  TEXT,
    "values"   TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_algopack_ttt ON algopack(ticker, type, ts)`,

  // Кэш перцентилей — пересчитываем в браузере, кладём сюда как бэкап
  // window_days — глубина окна в днях (7/14/30/60)
  `CREATE TABLE IF NOT EXISTS percentiles (
    key        TEXT PRIMARY KEY,
    ticker     TEXT NOT NULL,
    type       TEXT NOT NULL,
    field      TEXT NOT NULL,
    window_days INTEGER NOT NULL,
    p10        REAL,
    p25        REAL,
    p50        REAL,
    p75        REAL,
    p90        REAL,
    n          INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pct_ticker ON percentiles(ticker, type, window_days)`,

  // ATR по тикеру и таймфрейму — адаптивный порог "значимого движения"
  `CREATE TABLE IF NOT EXISTS atr (
    key        TEXT PRIMARY KEY,
    ticker     TEXT NOT NULL,
    tf         TEXT NOT NULL,
    atr        REAL NOT NULL,
    atr_pct    REAL NOT NULL,
    n          INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT 0
  )`,

  // Кэш вердиктов модуля indlab (RSI/MACD/... за 90 дней) — чтобы не пересчитывать на каждый запрос
  `CREATE TABLE IF NOT EXISTS ind_verdicts (
    ticker     TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    updated_at INTEGER DEFAULT 0
  )`,

  // Кэш сырых свечей по тикеру+интервалу для инкрементального пересчёта indlab —
  // при следующем запросе докачиваем только дни после last_ts, а не весь период.
  `CREATE TABLE IF NOT EXISTS ind_candles (
    key        TEXT PRIMARY KEY,
    ticker     TEXT NOT NULL,
    interval   TEXT NOT NULL,
    candles    TEXT NOT NULL,
    last_ts    INTEGER NOT NULL,
    updated_at INTEGER DEFAULT 0
  )`,

  // Дневные снэпшоты ОИ (юр/физ, лонг/шорт) + цена закрытия — копится с момента
  // включения фичи (FutOI не отдаёт историю позиций глубже окна AlgoPack),
  // на основе этой истории клиент строит слои позиций по дате/цене открытия
  // для анализа сквизов. Не чистим по времени — это и есть вся ценность таблицы.
  `CREATE TABLE IF NOT EXISTS oi_daily (
    key            TEXT PRIMARY KEY,
    ticker         TEXT NOT NULL,
    tradedate      TEXT NOT NULL,
    price          REAL DEFAULT 0,
    yur_long       REAL DEFAULT 0,
    yur_short      REAL DEFAULT 0,
    fiz_long       REAL DEFAULT 0,
    fiz_short      REAL DEFAULT 0,
    yur_long_num   REAL DEFAULT 0,
    yur_short_num  REAL DEFAULT 0,
    fiz_long_num   REAL DEFAULT 0,
    fiz_short_num  REAL DEFAULT 0,
    updated_at     INTEGER DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_oidaily_ticker ON oi_daily(ticker, tradedate)`,

  // Гистерезис-состояние автообхода фьючерсов в cron: тикер остаётся
  // в отборе, пока не упадёт ниже нижнего порога объёма (см. scheduledCollectOi)
  `CREATE TABLE IF NOT EXISTS oi_tracked_state (
    ticker     TEXT PRIMARY KEY,
    tracked    INTEGER DEFAULT 0,
    root       TEXT,
    updated_at INTEGER DEFAULT 0
  )`,

  // Часовые снэпшоты ОИ — cron срабатывает каждый час в торговые часы FORTS
  // (7:00-23:50 МСК = 4:00-20:50 UTC). Ключ = ticker__ts (unix ms).
  // oi_lab.html использует эту таблицу в hourly-режиме вместо развёртки
  // одного дневного снэпшота на все часы.
  `CREATE TABLE IF NOT EXISTS oi_hourly (
    key          TEXT PRIMARY KEY,
    ticker       TEXT NOT NULL,
    ts           INTEGER NOT NULL,
    price        REAL DEFAULT 0,
    yur_long     REAL DEFAULT 0,
    yur_short    REAL DEFAULT 0,
    fiz_long     REAL DEFAULT 0,
    fiz_short    REAL DEFAULT 0,
    yur_long_num  REAL DEFAULT 0,
    yur_short_num REAL DEFAULT 0,
    fiz_long_num  REAL DEFAULT 0,
    fiz_short_num REAL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_oihourly_ticker ON oi_hourly(ticker, ts)`,
];

// ── D1 Route Handler ───────────────────────────────────────────────────────
// Миграция для БД, созданных до добавления колонок *_num (число счетов —
// нужно индикатору OI Imbalance для Conviction/LiquidityConfidence). На уже
// существующей таблице ALTER TABLE ADD COLUMN падает, если колонка уже есть —
// поэтому try/catch на каждую, выполняется при каждом /db/init безболезненно.
const OI_DAILY_NUM_MIGRATIONS = [
  `ALTER TABLE oi_daily ADD COLUMN yur_long_num REAL DEFAULT 0`,
  `ALTER TABLE oi_daily ADD COLUMN yur_short_num REAL DEFAULT 0`,
  `ALTER TABLE oi_daily ADD COLUMN fiz_long_num REAL DEFAULT 0`,
  `ALTER TABLE oi_daily ADD COLUMN fiz_short_num REAL DEFAULT 0`,
];
async function migrateOiDailyNumCols(db) {
  for (const stmt of OI_DAILY_NUM_MIGRATIONS) {
    try { await db.prepare(stmt).run(); } catch (_) { /* колонка уже есть */ }
  }
}

// ── Upsert одного часового снэпшота в oi_hourly ──
async function upsertOiHourly(db, r) {
  const ts = r.ts || Date.now();
  const key = `${r.ticker}__${ts}`;
  await db.prepare(
    `INSERT OR REPLACE INTO oi_hourly
       (key,ticker,ts,price,yur_long,yur_short,fiz_long,fiz_short,
        yur_long_num,yur_short_num,fiz_long_num,fiz_short_num)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    key, r.ticker, ts,
    r.price || 0,
    r.yur_long || 0, r.yur_short || 0,
    r.fiz_long || 0, r.fiz_short || 0,
    r.yur_long_num || 0, r.yur_short_num || 0,
    r.fiz_long_num || 0, r.fiz_short_num || 0,
  ).run();
}

// ── Upsert одного снэпшока в oi_daily (общий код для /db/oidaily и cron) ──
async function upsertOiDaily(db, r) {
  await db.prepare(
    `INSERT OR REPLACE INTO oi_daily(key,ticker,tradedate,price,yur_long,yur_short,fiz_long,fiz_short,
       yur_long_num,yur_short_num,fiz_long_num,fiz_short_num,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    `${r.ticker}__${r.tradedate}`, r.ticker, r.tradedate, r.price ?? 0,
    r.yur_long ?? 0, r.yur_short ?? 0, r.fiz_long ?? 0, r.fiz_short ?? 0,
    r.yur_long_num ?? 0, r.yur_short_num ?? 0, r.fiz_long_num ?? 0, r.fiz_short_num ?? 0,
    Date.now()
  ).run();
}

const MSK_OFFSET_MS_W = 3 * 3600 * 1000; // МСК = UTC+3, для date-строк из ts

// ── FutOI короткий код тикера — те же правила, что в oi-signal-v10.html::futoi2sym ──
const FUTOI_FULL_MAP = {
  SBER:'SBERF', GAZP:'GAZPF', LKOH:'LKOHF', GMKN:'GMKNF', NVTK:'NVTKF',
  ROSN:'ROSNF', TATN:'TATNF', MGNT:'MGNTF', YNDX:'YDEX',  YDEX:'YD',
  IMOEX:'IMOEXF', GLDR:'GLDRUBF', EURR:'EURRUBF', CNYR:'CNYRUBF', USDR:'USDRUBF',
};
function futoi2sym(ticker) {
  for (const [k, v] of Object.entries(FUTOI_FULL_MAP)) {
    if (ticker.toUpperCase().startsWith(k)) return v;
  }
  const m = ticker.match(/^([A-Za-z]{2})/);
  return m ? m[1] : ticker;
}

// Базовый актив контракта (для группировки по фронт-месяцу): BRN6→BR, SiU6→Si, SBERM5→SBER
function contractRoot(ticker) {
  const m = ticker.match(/^([A-Za-z]+)[FGHJKMNQUVXZ]\d$/);
  return m ? m[1] : ticker;
}

// ── ISS helper: разворачивает любой блок {columns,data} в массив объектов ──
function issBlockToObjects(block) {
  if (!block || !block.columns || !block.data) return [];
  return block.data.map(row => {
    const obj = {};
    block.columns.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

// ── Cron: ежедневный автосбор oi_daily по ликвидным фьючерсам FORTS ──
async function scheduledCollectOi(env) {
  const db = DB(env);
  if (!db) { console.warn('oi cron: D1 binding не настроен'); return; }
  const moexKey = env.MOEX_KEY;
  if (!moexKey) { console.warn('oi cron: secret MOEX_KEY не задан — пропуск'); return; }

  // 1. Список всех фьючерсов FORTS с объёмом/ОИ/ценой/датой экспирации —
  // публичный ISS, без авторизации.
  const secResp = await fetch(
    'https://iss.moex.com/iss/engines/futures/markets/forts/securities.json?iss.meta=off'
  );
  if (!secResp.ok) { console.warn('oi cron: securities.json HTTP', secResp.status); return; }
  const secJson = await secResp.json();
  const merged = {}; // SECID -> объединённая строка из всех блоков ответа
  for (const key of Object.keys(secJson)) {
    const rows = issBlockToObjects(secJson[key]);
    rows.forEach(row => {
      const sid = row.SECID;
      if (!sid) return;
      merged[sid] = { ...(merged[sid] || {}), ...row };
    });
  }
  const today = new Date().toISOString().slice(0, 10);
  const all = Object.values(merged)
    .map(r => ({
      ticker: r.SECID,
      vol: Number(r.VOLTODAY ?? r.VALTODAY ?? 0) || 0,
      price: Number(r.LAST ?? r.MARKETPRICE ?? r.PREVSETTLEPRICE ?? r.SETTLEPRICE ?? 0) || 0,
      expiry: r.LASTTRADEDATE || r.LASTDELDATE || null,
    }))
    .filter(r => r.ticker && r.price > 0);
  if (!all.length) { console.warn('oi cron: пустой список фьючерсов'); return; }

  // 2. Гарантированный фронт-месяц по каждому базовому активу — независимо
  // от объёма, чтобы не терять только что начавший роллироваться контракт.
  const byRoot = {};
  all.forEach(r => {
    const root = contractRoot(r.ticker);
    if (!byRoot[root]) byRoot[root] = [];
    byRoot[root].push(r);
  });
  const frontByRoot = new Set();
  Object.values(byRoot).forEach(list => {
    const future = list.filter(r => r.expiry && r.expiry >= today);
    const pool = future.length ? future : list;
    pool.sort((a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999'));
    frontByRoot.add(pool[0].ticker);
  });

  // 3. Ранжирование по объёму + гистерезис (вход — топ-50%, выход — ниже топ-80%)
  const ranked = [...all].sort((a, b) => b.vol - a.vol);
  const n = ranked.length;
  const rankOf = {};
  ranked.forEach((r, i) => { rankOf[r.ticker] = n > 1 ? i / (n - 1) : 0; });
  const ENTER = 0.5, EXIT = 0.8;

  const { results: stateRows } = await db.prepare('SELECT ticker, tracked FROM oi_tracked_state').all();
  const prevTracked = {};
  stateRows.forEach(r => { prevTracked[r.ticker] = !!r.tracked; });

  const finalTickers = [];
  const stateUpdates = [];
  all.forEach(r => {
    const isFront = frontByRoot.has(r.ticker);
    const rank = rankOf[r.ticker] ?? 1;
    const was = !!prevTracked[r.ticker];
    const tracked = isFront || (was ? rank <= EXIT : rank <= ENTER);
    if (tracked) finalTickers.push(r);
    stateUpdates.push({ ticker: r.ticker, tracked: tracked ? 1 : 0, root: contractRoot(r.ticker) });
  });

  for (let i = 0; i < stateUpdates.length; i += 50) {
    const chunk = stateUpdates.slice(i, i + 50);
    await db.batch(chunk.map(s =>
      db.prepare('INSERT OR REPLACE INTO oi_tracked_state(ticker,tracked,root,updated_at) VALUES(?,?,?,?)')
        .bind(s.ticker, s.tracked, s.root, Date.now())
    ));
  }

  console.log(`oi cron: отобрано ${finalTickers.length} из ${all.length} фьючерсов`);

  // 4. Один запрос FutOI без ticker= — возвращает ВСЕ тикеры с текущим OI.
  // API обновляется каждые 5 минут, tradetime в ответе — время снэпшота.
  // Сохраняем каждую запись с её tradetime как ключом в oi_hourly.
  const now = new Date();
  const nowDow = now.getUTCDay(); // 0=вс, 6=сб
  const isTradingDay = nowDow >= 1 && nowDow <= 5;
  const nowHourUtc = now.getUTCHours();
  const isTradingHour = nowHourUtc >= 4 && nowHourUtc < 21;

  try {
    const futUrl = `https://apim.moex.com/iss/analyticalproducts/futoi/securities.json?iss.meta=off&limit=5000`;
    const futResp = await fetch(futUrl, { headers: { Authorization: `Bearer ${moexKey}`, Accept: 'application/json' } });
    if (!futResp.ok) {
      console.warn('oi cron: FutOI HTTP', futResp.status);
      return;
    }
    const futJson = await futResp.json();
    const block = futJson.futoi || futJson[Object.keys(futJson).find(k => k !== 'metadata' && k !== 'history')];
    const allRows = issBlockToObjects(block);

    // Группируем по тикеру: { sym → { YUR: row, FIZ: row } }
    // tradetime вида "HH:MM:SS" — берём последний снэпшот дня для oi_daily
    // и ВСЕ снэпшоты дня для oi_hourly (если данные инtraday)
    const byTicker = {};
    for (const o of allRows) {
      const g = (o.clgroup || '').toUpperCase();
      if (g !== 'YUR' && g !== 'FIZ') continue;
      const sym = o.ticker;
      if (!byTicker[sym]) byTicker[sym] = {};
      if (!byTicker[sym][g] || (o.tradetime || '') > (byTicker[sym][g].tradetime || ''))
        byTicker[sym][g] = o;
    }

    // Цена из securities.json (уже есть в finalTickers)
    const priceMap = {};
    for (const r of finalTickers) priceMap[futoi2sym(r.ticker)] = r.price;

    // Для отслеживаемых тикеров — сохраняем дневной снэпшот
    const trackedSyms = new Set(finalTickers.map(r => futoi2sym(r.ticker)));
    const toSave = [];
    for (const [sym, groups] of Object.entries(byTicker)) {
      if (!trackedSyms.has(sym)) continue;
      const Y = groups.YUR, F = groups.FIZ;
      const tradedate = (Y || F)?.tradedate || today;
      const tradetime = (Y || F)?.tradetime || '00:00:00';
      // Полный тикер (с месяцем) = ключ в oi_tracked_state; если не найден, используем sym
      const fullTicker = finalTickers.find(r => futoi2sym(r.ticker) === sym)?.ticker || sym;
      const rec = {
        ticker: fullTicker, sym,
        tradedate, tradetime,
        price: priceMap[sym] || 0,
        yur_long:     Number(Y?.pos_long  || 0),
        yur_short:    Math.abs(Number(Y?.pos_short || 0)),
        fiz_long:     Number(F?.pos_long  || 0),
        fiz_short:    Math.abs(Number(F?.pos_short || 0)),
        yur_long_num:  Number(Y?.pos_long_num  || 0),
        yur_short_num: Number(Y?.pos_short_num || 0),
        fiz_long_num:  Number(F?.pos_long_num  || 0),
        fiz_short_num: Number(F?.pos_short_num || 0),
      };
      toSave.push(rec);
    }

    // Batch upsert в oi_daily (дневной итог — по дате)
    for (let i = 0; i < toSave.length; i += 50) {
      const chunk = toSave.slice(i, i + 50);
      await db.batch(chunk.map(rec => {
        const key = `${rec.ticker}__${rec.tradedate}`;
        return db.prepare(
          `INSERT OR REPLACE INTO oi_daily
             (key,ticker,tradedate,price,yur_long,yur_short,fiz_long,fiz_short,
              yur_long_num,yur_short_num,fiz_long_num,fiz_short_num,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(key, rec.ticker, rec.tradedate, rec.price,
               rec.yur_long, rec.yur_short, rec.fiz_long, rec.fiz_short,
               rec.yur_long_num, rec.yur_short_num, rec.fiz_long_num, rec.fiz_short_num,
               Date.now());
      }));
    }

    // В торговое время — дополнительно пишем в oi_hourly с ключом ticker__tradedate__tradetime
    // Так сохраняется каждый 5-минутный снэпшот отдельно.
    if (isTradingDay && isTradingHour) {
      const tsFromApi = (rec) => {
        const dt = `${rec.tradedate}T${rec.tradetime}+03:00`; // МСК = UTC+3
        const ms = new Date(dt).getTime();
        return isFinite(ms) ? ms : Date.now();
      };
      for (let i = 0; i < toSave.length; i += 50) {
        const chunk = toSave.slice(i, i + 50);
        await db.batch(chunk.map(rec => {
          const ts = tsFromApi(rec);
          const key = `${rec.ticker}__${rec.tradedate}__${rec.tradetime}`;
          return db.prepare(
            `INSERT OR REPLACE INTO oi_hourly
               (key,ticker,ts,price,yur_long,yur_short,fiz_long,fiz_short,
                yur_long_num,yur_short_num,fiz_long_num,fiz_short_num)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(key, rec.ticker, ts, rec.price,
                 rec.yur_long, rec.yur_short, rec.fiz_long, rec.fiz_short,
                 rec.yur_long_num, rec.yur_short_num, rec.fiz_long_num, rec.fiz_short_num);
        }));
      }
      console.log(`oi cron: ${toSave.length} тикеров → oi_daily + oi_hourly (${today} ${(toSave[0]?.tradetime || '')})`);
    } else {
      console.log(`oi cron: ${toSave.length} тикеров → oi_daily only`);
    }
  } catch (e) {
    console.error('oi cron: FutOI fetch failed:', e.message);
  }
}

// ── Backfill: разовая подтяжка истории FutOI (юр/физ) за прошлые даты ──
// futoi/securities.json принимает date= и отдаёт срез на конкретный день,
// поэтому глубину истории тянем циклом по датам (а не диапазоном за раз).
// Разовая подтяжка истории FutOI через СЕРИЙНЫЙ endpoint
// futoi/securities/{sym}.json?from=&till= с пагинацией start= — все снэпшоты
// одного тикера за диапазон дат. Коллекционный securities.json?date= для
// этого непригоден: ticker= там игнорируется (приходят все ~65 тикеров разом,
// ~130 строк на один 5-минутный срез) и limit=1000 покрывает только последние
// ~40 минут дня; вдобавок сто запросов по датам ловили rate-limit MOEX.
// Диагностика /db/oitest показала: глубина futoi у ключа — с 2020 года.
//
// В oi_hourly пишутся снэпшоты с шагом step минут (по умолчанию 30: полный
// 5-минутный поток за 100 дней — ~36 тыс. строк на тикер, лимит сабзапросов
// Workers не резиновый), в oi_daily — последний снэпшот каждой даты.
async function backfillOiHistory(db, env, tickers, days, stepMin = 30, startOffset = 0, maxPages = 25, tillOverride = null) {
  const moexKey = env.MOEX_KEY;
  if (!moexKey) return { error: 'secret MOEX_KEY не задан' };
  // Базы, созданные до появления oi_hourly, не имеют этой таблицы, если
  // /db/init с тех пор не перезапускался — бэкфилл тогда падает на каждой
  // записи с «no such table». Создаём сами, IF NOT EXISTS безопасен.
  await db.prepare(`CREATE TABLE IF NOT EXISTS oi_hourly (
    key TEXT PRIMARY KEY, ticker TEXT NOT NULL, ts INTEGER NOT NULL,
    price REAL DEFAULT 0,
    yur_long REAL DEFAULT 0, yur_short REAL DEFAULT 0,
    fiz_long REAL DEFAULT 0, fiz_short REAL DEFAULT 0,
    yur_long_num REAL DEFAULT 0, yur_short_num REAL DEFAULT 0,
    fiz_long_num REAL DEFAULT 0, fiz_short_num REAL DEFAULT 0
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_oihourly_ticker ON oi_hourly(ticker, ts)`).run();
  const from = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
  let till = new Date().toISOString().slice(0, 10);
  let saved = 0, savedIntraday = 0, failed = 0, pagesTotal = 0;
  const errors = [];
  const noteErr = (ctx, msg) => { if (errors.length < 5) errors.push(`${ctx}: ${msg}`); };

  // Возобновляемость: бесплатный план Workers даёт всего 50 сабзапросов на
  // вызов (страница = fetch, батч записи = запрос к D1). Один вызов съедает
  // бюджет maxPages страниц и возвращает done:false + nextStart — следующий
  // вызов с &start=nextStart продолжает с того же места. Клиент (браузер)
  // просто дёргает URL в цикле, у каждого вызова лимит свой.
  let start = Number.isFinite(startOffset) ? startOffset : 0;
  let done = true;
  let rowsFetched = 0, rowsMatched = 0;
  let minDate = null, maxDate = null;

  for (const ticker of tickers) {
    const sym = futoi2sym(ticker);
    // Возобновление МЕЖДУ запусками: серия листается от свежих к старым, и
    // повторный запуск с start=0 заново гонял бы уже сохранённые страницы.
    // Сужаем till до самой старой уже записанной даты тикера (её же
    // перезапрашиваем целиком — день мог быть записан частично; REPLACE по
    // ключу дублей не даёт) — цепочка продолжает вглубь, а не с сегодня.
    // ВАЖНО: внутри одной цепочки start-offset имеет смысл только при
    // НЕИЗМЕННОМ till (записи первого вызова сдвинули бы min-дату) — поэтому
    // клиент передаёт till= из ответа первого вызова на все последующие.
    if (tillOverride) {
      till = tillOverride;
    } else if (startOffset === 0) {
      try {
        const { results } = await db.prepare('SELECT MIN(ts) AS m FROM oi_hourly WHERE ticker=?').bind(ticker).all();
        const m = results?.[0]?.m;
        if (m) {
          const d = new Date(m + MSK_OFFSET_MS_W).toISOString().slice(0, 10);
          if (d < till) till = d;
        }
      } catch (_) { /* таблицы может не быть — не критично */ }
    }
    if (till < from) { continue; } // история уже глубже from — нечего тянуть
    // 1. Страницы серии (ISS отдаёт по limit строк, листаем start=)
    const rowsAll = [];
    for (let page = 0; page < maxPages; page++) {
      try {
        if (pagesTotal > 0) await new Promise(r => setTimeout(r, 150)); // не дразнить rate-limit
        // iss.only + columns: тянем только нужный блок и колонки — JSON в разы
        // легче, а CPU-время на парсинг (лимит бесплатного плана) — меньше
        const url = `https://apim.moex.com/iss/analyticalproducts/futoi/securities/${encodeURIComponent(sym)}.json?from=${from}&till=${till}&iss.meta=off&iss.only=futoi&futoi.columns=ticker,tradedate,tradetime,clgroup,pos_long,pos_short,pos_long_num,pos_short_num&limit=1000&start=${start}`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${moexKey}`, Accept: 'application/json' } });
        if (!resp.ok) { failed++; noteErr(`${sym} стр.${page}`, `HTTP ${resp.status} ${(await resp.text().catch(()=>'')).slice(0,120)}`); break; }
        const j = await resp.json();
        const block = j.futoi || j[Object.keys(j).find(k => k !== 'metadata' && k !== 'history' && k !== 'futoi.dates')];
        const rows = issBlockToObjects(block);
        pagesTotal++;
        if (!rows.length) break;
        rowsFetched += rows.length;
        const mine = rows.filter(o => o.ticker === sym);
        rowsMatched += mine.length;
        for (const o of mine) {
          if (o.tradedate) {
            if (!minDate || o.tradedate < minDate) minDate = o.tradedate;
            if (!maxDate || o.tradedate > maxDate) maxDate = o.tradedate;
          }
        }
        rowsAll.push(...mine);
        start += 1000;
        if (rows.length < 1000) { start = 0; break; } // серия дочитана до конца
        // Серия идёт от свежих к старым: если вся страница уже старше from,
        // дальше только более старая история — дочитывать незачем (страховка
        // на случай, если from= на стороне MOEX не фильтрует)
        const pageNewest = rows.reduce((m, o) => (o.tradedate && o.tradedate > m) ? o.tradedate : m, '');
        if (pageNewest && pageNewest < from) { start = 0; break; }
        if (page === maxPages - 1) done = false;      // бюджет вызова исчерпан
      } catch (e) { failed++; noteErr(`${sym} стр.${page}`, e.message.slice(0, 120)); done = false; break; }
    }
    if (!rowsAll.length) continue;

    // 2. Группировка по (дата, время): YUR и FIZ одного среза — в одну запись
    const byKey = {};
    for (const o of rowsAll) {
      const g = (o.clgroup || '').toUpperCase();
      if (g !== 'YUR' && g !== 'FIZ') continue;
      // Время среза нормализуется до минуты: серия local отдаёт обновления
      // чаще раза в минуту, и без нормализации каждый секундный тик внутри
      // «минуты шага» плодил бы отдельную запись (при 30-мин шаге — по 5-6
      // почти одинаковых строк на точку). Берётся последнее значение минуты.
      const k = `${o.tradedate}__${(o.tradetime || '00:00:00').slice(0, 5)}:00`;
      (byKey[k] = byKey[k] || {})[g] = o;
    }

    // 3. oi_hourly: срезы с шагом stepMin; попутно ищем последний срез дня.
    // Ключ — формат live-крона (ticker__date__time), дублей не будет.
    const hourlyStmts = [];
    const lastOfDay = {};
    for (const [k, groups] of Object.entries(byKey)) {
      const [td, tt] = k.split('__');
      if (!lastOfDay[td] || tt > lastOfDay[td].tt) lastOfDay[td] = { tt, groups };
      if (parseInt(tt.slice(3, 5), 10) % stepMin !== 0) continue;
      const ts = new Date(`${td}T${tt}+03:00`).getTime(); // tradetime — МСК
      if (!isFinite(ts)) continue;
      const Y = groups.YUR, F = groups.FIZ;
      hourlyStmts.push(db.prepare(
        `INSERT OR REPLACE INTO oi_hourly
           (key,ticker,ts,price,yur_long,yur_short,fiz_long,fiz_short,
            yur_long_num,yur_short_num,fiz_long_num,fiz_short_num)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        `${ticker}__${td}__${tt}`, ticker, ts, 0,
        Number(Y?.pos_long || 0), Math.abs(Number(Y?.pos_short || 0)),
        Number(F?.pos_long || 0), Math.abs(Number(F?.pos_short || 0)),
        Number(Y?.pos_long_num || 0), Number(Y?.pos_short_num || 0),
        Number(F?.pos_long_num || 0), Number(F?.pos_short_num || 0),
      ));
    }
    for (let i = 0; i < hourlyStmts.length; i += 80) {
      await db.batch(hourlyStmts.slice(i, i + 80));
    }
    savedIntraday += hourlyStmts.length;

    // 4. oi_daily: последний срез каждой даты
    const dailyStmts = Object.entries(lastOfDay).map(([td, { groups }]) => {
      const Y = groups.YUR, F = groups.FIZ;
      return db.prepare(
        `INSERT OR REPLACE INTO oi_daily
           (key,ticker,tradedate,price,yur_long,yur_short,fiz_long,fiz_short,
            yur_long_num,yur_short_num,fiz_long_num,fiz_short_num,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        `${ticker}__${td}`, ticker, td, 0,
        Number(Y?.pos_long || 0), Math.abs(Number(Y?.pos_short || 0)),
        Number(F?.pos_long || 0), Math.abs(Number(F?.pos_short || 0)),
        Number(Y?.pos_long_num || 0), Number(Y?.pos_short_num || 0),
        Number(F?.pos_long_num || 0), Number(F?.pos_short_num || 0),
        Date.now(),
      );
    });
    for (let i = 0; i < dailyStmts.length; i += 80) {
      await db.batch(dailyStmts.slice(i, i + 80));
    }
    saved += dailyStmts.length;
  }
  return { tickers: tickers.length, days, from, till, step: stepMin, pages: pagesTotal,
    rowsFetched, rowsMatched, matchedDates: minDate ? [minDate, maxDate] : null,
    saved, savedIntraday, failed, errors,
    done, nextStart: done ? null : start };
}

async function handleDb(path, req, env) {
  const db = DB(env);
  if (!db) return json({ error: 'D1 binding "OI_DB" не настроен' }, 503);

  const p = path.replace(/^\/db/, '');

  // ── Init ──
  if (p === '/init') {
    for (const stmt of SCHEMA_STMTS) {
      await db.prepare(stmt).run();
    }
    await migrateOiDailyNumCols(db);
    return json({ ok: true, msg: 'schema ready (v3 — oi_hourly)' });
  }

  // ── Candles ──
  if (p === '/candles' && req.method === 'POST') {
    const rows = await req.json();
    if (!Array.isArray(rows) || !rows.length) return json({ ok: true, inserted: 0 });
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      await db.batch(chunk.map(r =>
        db.prepare('INSERT OR REPLACE INTO candles(key,ticker,tf,time,o,h,l,cl,vol) VALUES(?,?,?,?,?,?,?,?,?)')
          .bind(r.key, r.ticker, r.tf, r.time, r.o, r.h, r.l, r.cl, r.vol ?? 0)
      ));
    }
    return json({ ok: true, inserted: rows.length });
  }

  if (p === '/candles' && req.method === 'GET') {
    const u = new URL(req.url);
    const ticker = u.searchParams.get('ticker');
    const tf     = u.searchParams.get('tf');
    const from   = parseInt(u.searchParams.get('from') || '0');
    if (!ticker || !tf) return json({ error: 'ticker and tf required' }, 400);
    const { results } = await db.prepare(
      'SELECT * FROM candles WHERE ticker=? AND tf=? AND time>=? ORDER BY time ASC LIMIT 2000'
    ).bind(ticker, tf, from).all();
    return json(results);
  }

  // ── Поиск FIGI по тикеру: /db/findfigi?query=SSU6 ──
  if (p === '/findfigi' && req.method === 'GET') {
    const query = new URL(req.url).searchParams.get('query');
    if (!query) return json({ error: 'query required' }, 400);
    const token = env.TINVEST_TOKEN;
    if (!token) return json({ error: 'TINVEST_TOKEN не задан' }, 503);
    const resp = await fetch('https://invest-public-api.tinkoff.ru/rest/tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, instrumentKind: 'INSTRUMENT_TYPE_FUTURES' }),
    });
    const body = await resp.json();
    return json({ status: resp.status, instruments: (body.instruments || []).map(i => ({ figi: i.figi, ticker: i.ticker, name: i.name })) });
  }

  // ── Бэкфилл дневных свечей из T-Invest: /db/candles/tinvest?ticker=SSU6&figi=FUT...&from=2026-03-01&to=2026-07-01 ──
  // Требует secret TINVEST_TOKEN в CF Worker settings.
  if (p === '/candles/tinvest' && req.method === 'GET') {
    const u = new URL(req.url);
    const ticker = u.searchParams.get('ticker');
    let   figi   = u.searchParams.get('figi');
    const from   = u.searchParams.get('from') || '2026-01-01';
    const to     = u.searchParams.get('to')   || new Date().toISOString().slice(0,10);
    if (!ticker) return json({ error: 'ticker required' }, 400);
    const token = env.TINVEST_TOKEN;
    if (!token) return json({ error: 'TINVEST_TOKEN secret не задан в CF Worker' }, 503);

    // Автопоиск FIGI: пробуем полный тикер, затем 2-буквенный sym
    if (!figi) {
      const sym = ticker.match(/^([A-Za-z]{2})/)?.[1] || ticker;
      const queries = ticker !== sym ? [ticker, sym] : [ticker];
      for (const q of queries) {
        const fr = await fetch('https://invest-public-api.tinkoff.ru/rest/tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q, instrumentKind: 'INSTRUMENT_TYPE_FUTURES', apiTradeAvailableFlag: false }),
        });
        if (fr.ok) {
          const fb = await fr.json();
          const inst = (fb.instruments || []).find(i => i.ticker === ticker || i.ticker === q || i.ticker?.startsWith(sym));
          if (inst?.figi) { figi = inst.figi; break; }
        }
      }
      if (!figi) return json({ error: `Не удалось найти FIGI для тикера ${ticker}` }, 404);
    }
    const tfParam = u.searchParams.get('tf') || 'day';
    const intervalMap = { day: 'CANDLE_INTERVAL_DAY', hour: 'CANDLE_INTERVAL_HOUR', '15min': 'CANDLE_INTERVAL_15_MIN', '5min': 'CANDLE_INTERVAL_5_MIN' };
    const interval = intervalMap[tfParam] || 'CANDLE_INTERVAL_DAY';
    const resp = await fetch('https://invest-public-api.tinkoff.ru/rest/tinkoff.public.invest.api.contract.v1.MarketDataService/GetCandles', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ figi, from: new Date(from).toISOString(), to: new Date(to + 'T23:59:59Z').toISOString(), interval }),
    });
    if (!resp.ok) return json({ error: `T-Invest HTTP ${resp.status}`, body: await resp.text() }, 502);
    const body = await resp.json();
    const candles = body.candles || [];
    if (!candles.length) return json({ ticker, saved: 0, empty: true });
    const rows = candles.map(c => {
      const ts = Math.floor(new Date(c.time).getTime() / 1000);
      const price = f => (f?.units ? Number(f.units) + (f.nano || 0) / 1e9 : 0);
      return { key: `${ticker}__${tfParam}__${ts}`, ticker, tf: tfParam, time: ts,
               o: price(c.open), h: price(c.high), l: price(c.low), cl: price(c.close), vol: c.volume ?? 0 };
    });
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i+100);
      await db.batch(chunk.map(r =>
        db.prepare('INSERT OR REPLACE INTO candles(key,ticker,tf,time,o,h,l,cl,vol) VALUES(?,?,?,?,?,?,?,?,?)')
          .bind(r.key, r.ticker, r.tf, r.time, r.o, r.h, r.l, r.cl, r.vol)
      ));
    }
    return json({ ticker, tf: tfParam, saved: rows.length, from, to });
  }

  // ── Signals ──
  if (p === '/signal' && req.method === 'POST') {
    const s = await req.json();
    const r = await db.prepare(
      `INSERT INTO signals(ts,ticker,tf,entry_price,entry_ts,composite,dir,methods)
       VALUES(?,?,?,?,?,?,?,?)`
    ).bind(s.ts, s.ticker, s.tf, s.entry_price ?? 0, s.entry_ts ?? 0,
           s.composite ?? 0, s.dir ?? 'neutral', JSON.stringify(s.methods ?? {})).run();
    return json({ ok: true, id: r.meta.last_row_id });
  }

  const sigPatch = p.match(/^\/signal\/(\d+)$/);
  if (sigPatch && req.method === 'PATCH') {
    const id = parseInt(sigPatch[1]);
    const patch = await req.json();
    const fields = Object.keys(patch).map(k => `${k}=?`).join(',');
    await db.prepare(`UPDATE signals SET ${fields} WHERE id=?`)
      .bind(...Object.values(patch), id).run();
    return json({ ok: true });
  }

  if (p.startsWith('/signals') && req.method === 'GET') {
    const u = new URL(req.url);
    const ticker   = u.searchParams.get('ticker');
    const resolved = u.searchParams.get('resolved');
    let q = 'SELECT * FROM signals WHERE 1=1';
    const binds = [];
    if (ticker)            { q += ' AND ticker=?';   binds.push(ticker); }
    if (resolved !== null) { q += ' AND resolved=?'; binds.push(parseInt(resolved)); }
    q += ' ORDER BY id DESC LIMIT 500';
    const { results } = await db.prepare(q).bind(...binds).all();
    results.forEach(r => { try { r.methods = JSON.parse(r.methods); } catch(_){} });
    return json(results);
  }

  // ── Weights ──
  if (p === '/weight' && req.method === 'POST') {
    const w = await req.json();
    await db.prepare(
      `INSERT OR REPLACE INTO weights(key,ticker,method_id,weight,total,sum_quality,updated_at)
       VALUES(?,?,?,?,?,?,?)`
    ).bind(`${w.ticker}__${w.method_id}`, w.ticker, w.method_id,
           w.weight ?? 0.5, w.total ?? 0, w.sum_quality ?? 0, Date.now()).run();
    return json({ ok: true });
  }

  if (p.startsWith('/weights') && req.method === 'GET') {
    const ticker = new URL(req.url).searchParams.get('ticker');
    if (!ticker) return json({ error: 'ticker required' }, 400);
    const { results } = await db.prepare('SELECT * FROM weights WHERE ticker=?').bind(ticker).all();
    return json(results);
  }

  // ── AlgoPack history ──
  // POST body: { ticker, type, rows: [{tradedate, tradetime, ...fields}] }
  // key = ticker__type__tradedate__tradetime
  if (p === '/algopack' && req.method === 'POST') {
    const body = await req.json();
    const { ticker, type, rows } = body;
    if (!ticker || !type || !Array.isArray(rows) || !rows.length)
      return json({ error: 'ticker, type, rows required' }, 400);

    // Чистим старые данные старше 90 дней чтобы база не росла бесконечно
    const cutoff = Date.now() - 90 * 86400 * 1000;
    await db.prepare('DELETE FROM algopack WHERE ticker=? AND type=? AND ts<?')
      .bind(ticker, type, cutoff).run();

    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      await db.batch(chunk.map(r => {
        const date = r.tradedate || '';
        const time = r.tradetime || r.systime?.slice(11,19) || '00:00:00';
        const tsMs = date ? new Date(`${date}T${time}Z`).getTime() : Date.now();
        const key  = `${ticker}__${type}__${date}__${time}`;
        return db.prepare(
          `INSERT OR REPLACE INTO algopack(key,ticker,type,ts,tradedate,tradetime,"values")
           VALUES(?,?,?,?,?,?,?)`
        ).bind(key, ticker, type, tsMs, date, time, JSON.stringify(r));
      }));
    }
    return json({ ok: true, inserted: rows.length });
  }

  if (p.startsWith('/algopack') && req.method === 'GET') {
    const u      = new URL(req.url);
    const ticker = u.searchParams.get('ticker');
    const type   = u.searchParams.get('type');
    const days   = parseInt(u.searchParams.get('days') || '30');
    const limit  = parseInt(u.searchParams.get('limit') || '2000');
    if (!ticker || !type) return json({ error: 'ticker and type required' }, 400);
    const from = Date.now() - days * 86400 * 1000;
    const { results } = await db.prepare(
      `SELECT tradedate, tradetime, "values" FROM algopack
       WHERE ticker=? AND type=? AND ts>=?
       ORDER BY ts ASC LIMIT ?`
    ).bind(ticker, type, from, limit).all();
    // Разворачиваем JSON-поле values обратно в объекты
    const parsed = results.map(r => {
      try { return JSON.parse(r["values"]); } catch(_) { return {}; }
    });
    return json(parsed);
  }

  // ── Percentiles cache ──
  // POST body: { ticker, type, field, window_days, p10, p25, p50, p75, p90, n }
  if (p === '/percentiles' && req.method === 'POST') {
    const rows = await req.json();
    const arr = Array.isArray(rows) ? rows : [rows];
    for (let i = 0; i < arr.length; i += 100) {
      const chunk = arr.slice(i, i + 100);
      await db.batch(chunk.map(r =>
        db.prepare(
          `INSERT OR REPLACE INTO percentiles
           (key,ticker,type,field,window_days,p10,p25,p50,p75,p90,n,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          `${r.ticker}__${r.type}__${r.field}__${r.window_days}`,
          r.ticker, r.type, r.field, r.window_days,
          r.p10 ?? null, r.p25 ?? null, r.p50 ?? null, r.p75 ?? null, r.p90 ?? null,
          r.n ?? 0, Date.now()
        )
      ));
    }
    return json({ ok: true, saved: arr.length });
  }

  if (p.startsWith('/percentiles') && req.method === 'GET') {
    const u      = new URL(req.url);
    const ticker = u.searchParams.get('ticker');
    const window_days = u.searchParams.get('window');
    if (!ticker) return json({ error: 'ticker required' }, 400);
    let q = 'SELECT * FROM percentiles WHERE ticker=?';
    const binds = [ticker];
    if (window_days) { q += ' AND window_days=?'; binds.push(parseInt(window_days)); }
    const { results } = await db.prepare(q).bind(...binds).all();
    return json(results);
  }

  // ── ATR ──
  // POST body: { ticker, tf, atr, atr_pct, n }
  if (p === '/atr' && req.method === 'POST') {
    const r = await req.json();
    await db.prepare(
      `INSERT OR REPLACE INTO atr(key,ticker,tf,atr,atr_pct,n,updated_at)
       VALUES(?,?,?,?,?,?,?)`
    ).bind(`${r.ticker}__${r.tf}`, r.ticker, r.tf,
           r.atr ?? 0, r.atr_pct ?? 0, r.n ?? 0, Date.now()).run();
    return json({ ok: true });
  }

  if (p.startsWith('/atr') && req.method === 'GET') {
    const ticker = new URL(req.url).searchParams.get('ticker');
    if (!ticker) return json({ error: 'ticker required' }, 400);
    const { results } = await db.prepare('SELECT * FROM atr WHERE ticker=?').bind(ticker).all();
    return json(results);
  }

  // ── Кэш вердиктов indlab ──
  // POST body: { ticker, ...verdict }
  if (p === '/indverdict' && req.method === 'POST') {
    const r = await req.json();
    const { ticker, ...verdict } = r;
    if (!ticker) return json({ error: 'ticker required' }, 400);
    await db.prepare(
      `INSERT OR REPLACE INTO ind_verdicts(ticker,payload,updated_at) VALUES(?,?,?)`
    ).bind(ticker, JSON.stringify(verdict), Date.now()).run();
    return json({ ok: true });
  }

  if (p.startsWith('/indverdict') && req.method === 'GET') {
    const ticker = new URL(req.url).searchParams.get('ticker');
    if (!ticker) return json({ error: 'ticker required' }, 400);
    const row = await db.prepare('SELECT payload, updated_at FROM ind_verdicts WHERE ticker=?').bind(ticker).first();
    if (!row) return json(null);
    let verdict; try { verdict = JSON.parse(row.payload); } catch(_) { verdict = {}; }
    return json({ ...verdict, updated_at: row.updated_at });
  }

  // ── Кэш свечей для инкрементального пересчёта indlab ──
  // POST body: { ticker, interval, candles, last_ts }
  if (p === '/indcandles' && req.method === 'POST') {
    const r = await req.json();
    const { ticker, interval, candles, last_ts } = r;
    if (!ticker || !interval || !Array.isArray(candles)) return json({ error: 'ticker, interval, candles required' }, 400);
    await db.prepare(
      `INSERT OR REPLACE INTO ind_candles(key,ticker,interval,candles,last_ts,updated_at) VALUES(?,?,?,?,?,?)`
    ).bind(`${ticker}__${interval}`, ticker, interval, JSON.stringify(candles), last_ts || 0, Date.now()).run();
    return json({ ok: true });
  }

  if (p.startsWith('/indcandles') && req.method === 'GET') {
    const u = new URL(req.url);
    const ticker = u.searchParams.get('ticker');
    const interval = u.searchParams.get('interval');
    if (!ticker || !interval) return json({ error: 'ticker and interval required' }, 400);
    const row = await db.prepare('SELECT candles, last_ts, updated_at FROM ind_candles WHERE key=?').bind(`${ticker}__${interval}`).first();
    if (!row) return json(null);
    let candles; try { candles = JSON.parse(row.candles); } catch(_) { candles = []; }
    return json({ candles, last_ts: row.last_ts, updated_at: row.updated_at });
  }

  // ── Дневные снэпшоты ОИ (для построения слоёв позиций / риска сквиза) ──
  // POST body: { ticker, tradedate, price, yur_long, yur_short, fiz_long, fiz_short }
  if (p === '/oidaily' && req.method === 'POST') {
    const r = await req.json();
    if (!r.ticker || !r.tradedate) return json({ error: 'ticker and tradedate required' }, 400);
    await upsertOiDaily(db, r);
    return json({ ok: true });
  }

  if (p === '/tickers' && req.method === 'GET') {
    const { results } = await db.prepare(
      'SELECT ticker, COUNT(*) as days, MIN(tradedate) as from_date, MAX(tradedate) as to_date FROM oi_daily GROUP BY ticker ORDER BY ticker ASC'
    ).all();
    return json(results);
  }

  if (p === '/oidaily' && req.method === 'GET') {
    const ticker = new URL(req.url).searchParams.get('ticker');
    if (!ticker) return json({ error: 'ticker required' }, 400);
    const { results } = await db.prepare(
      'SELECT * FROM oi_daily WHERE ticker=? ORDER BY tradedate ASC'
    ).bind(ticker).all();
    return json(results);
  }

  // ── Часовые снэпшоты ОИ ──
  // POST body: { ticker, ts, price, yur_long, yur_short, fiz_long, fiz_short, ... }
  // GET ?ticker=SSU6[&from=<unix_ms>][&days=90] — все записи за период
  if (p === '/oihourly' && req.method === 'POST') {
    const r = await req.json();
    if (!r.ticker) return json({ error: 'ticker required' }, 400);
    await upsertOiHourly(db, r);
    return json({ ok: true });
  }

  if (p.startsWith('/oihourly') && req.method === 'GET') {
    const u      = new URL(req.url);
    const ticker = u.searchParams.get('ticker');
    if (!ticker) return json({ error: 'ticker required' }, 400);
    const days   = parseInt(u.searchParams.get('days') || '90');
    const from   = parseInt(u.searchParams.get('from') || '0') ||
                   (Date.now() - days * 86400 * 1000);
    const { results } = await db.prepare(
      'SELECT * FROM oi_hourly WHERE ticker=? AND ts>=? ORDER BY ts ASC LIMIT 5000'
    ).bind(ticker, from).all();
    return json(results);
  }

  // ── Диагностика: /db/oitest?ticker=SSU6&date=2026-06-25 — сырой ответ FutOI API ──
  if (p === '/oitest' && req.method === 'GET') {
    const u = new URL(req.url);
    const ticker = u.searchParams.get('ticker');
    const date   = u.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    if (!ticker) return json({ error: 'ticker required' }, 400);
    const sym = futoi2sym(ticker);
    const url = `https://apim.moex.com/iss/analyticalproducts/futoi/securities.json?ticker=${encodeURIComponent(sym)}&date=${date}&iss.meta=off&limit=1000`;
    const moexKey = env.MOEX_KEY;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${moexKey}`, Accept: 'application/json' } });
    const text = await resp.text();
    let body; try { body = JSON.parse(text); } catch(_) { body = text; }
    return json({ sym, date, status: resp.status, body });
  }

  // ── Разовый backfill одной даты: /db/oibackfill?date=2026-06-25[&all=1|&tickers=X] ──
  // all=1 — сохранить все тикеры из ответа FutOI без фильтра.
  if (p === '/oibackfill' && req.method === 'GET') {
    const u = new URL(req.url);
    const saveAll = u.searchParams.get('all') === '1';
    let tickers = (u.searchParams.get('tickers') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!saveAll && !tickers.length) {
      const { results } = await db.prepare('SELECT ticker FROM oi_tracked_state WHERE tracked=1').all();
      tickers = results.map(r => r.ticker);
    }
    if (!saveAll && !tickers.length) return json({ error: 'нет тикеров: пусто и в параметре, и в oi_tracked_state' }, 400);

    // Если передан date= — один запрос на всю дату, сохраняем все запрошенные тикеры.
    // FutOI API возвращает ВСЕ тикеры в одном ответе, поэтому делаем 1 fetch на дату.
    const singleDate = u.searchParams.get('date');

    // ── Интрадей-бэкфилл ОДНОЙ ДАТЫ для ВСЕХ тикеров разом: date=&intraday=1 ──
    // Серийный endpoint (futoi/securities/{sym}) оказался тупиком для массовой
    // закачки: он пишет строку на каждое обновление (тысячи строк на тикер в
    // день), и постраничная прокрутка одного AF дошла до offset 1.4 млн.
    // Коллекционный же запрос ?date= отдаёт весь день ВСЕХ ~65 тикеров
    // 5-минутными срезами (~23 тыс. строк = 2-3 страницы по 10000) — на два
    // порядка дешевле: ~3 запроса к MOEX на дату за весь пул сразу.
    if (singleDate && u.searchParams.get('intraday') === '1') {
      const moexKey = env.MOEX_KEY;
      const stepMin = Math.max(5, Math.min(Number(u.searchParams.get('step')) || 30, 60));
      await db.prepare(`CREATE TABLE IF NOT EXISTS oi_hourly (
        key TEXT PRIMARY KEY, ticker TEXT NOT NULL, ts INTEGER NOT NULL,
        price REAL DEFAULT 0,
        yur_long REAL DEFAULT 0, yur_short REAL DEFAULT 0,
        fiz_long REAL DEFAULT 0, fiz_short REAL DEFAULT 0,
        yur_long_num REAL DEFAULT 0, yur_short_num REAL DEFAULT 0,
        fiz_long_num REAL DEFAULT 0, fiz_short_num REAL DEFAULT 0
      )`).run();
      const pstart = Math.max(0, Number(u.searchParams.get('pstart')) || 0);
      // Быстрый скип уже закрытой даты — повторный прогон не жжёт запросы к MOEX
      if (pstart === 0 && u.searchParams.get('skipdone') === '1') {
        const dayFrom = new Date(`${singleDate}T00:00:00+03:00`).getTime();
        const dayTill = dayFrom + 86400 * 1000;
        const { results } = await db.prepare('SELECT COUNT(*) AS c FROM oi_hourly WHERE ts>=? AND ts<?').bind(dayFrom, dayTill).all();
        // Полный день пула ~1950 срезов (65 тикеров × ~30 отметок), прерванная
        // на середине дата ~975 — порог 1500 отличает целые дни от огрызков
        if ((results?.[0]?.c || 0) >= 1500) return json({ date: singleDate, skipped: true, existing: results[0].c });
      }
      try {
        // MOEX режет страницу до 1000 строк независимо от limit= (проверено:
        // limit=10000 вернул ровно 1000, и «весь день» оказался последними
        // 40 минутами — в базу попало по одному срезу на тикер). Листаем по
        // ФАКТИЧЕСКОМУ размеру страницы; день не влезает в бюджет одного
        // вызова (лимит 50 сабзапросов) — возвращаем nextPstart, клиент
        // продолжает ту же дату следующим вызовом.
        const allRows = [];
        let pages = 0, start2 = pstart, finished = false;
        for (; pages < 12; ) {
          const url2 = `https://apim.moex.com/iss/analyticalproducts/futoi/securities.json?ticker=SS&date=${singleDate}&iss.meta=off&iss.only=futoi&futoi.columns=ticker,tradedate,tradetime,clgroup,pos_long,pos_short,pos_long_num,pos_short_num&limit=1000&start=${start2}`;
          const resp = await fetch(url2, { headers: { Authorization: `Bearer ${moexKey}`, Accept: 'application/json' } });
          if (!resp.ok) return json({ date: singleDate, savedIntraday: 0, failed: 1, httpStatus: resp.status });
          const j2 = await resp.json();
          const rows2 = issBlockToObjects(j2.futoi || j2[Object.keys(j2).find(k => k !== 'metadata' && k !== 'history' && k !== 'futoi.dates')]);
          pages++;
          if (!rows2.length) { finished = true; break; }
          allRows.push(...rows2);
          start2 += rows2.length;
          if (rows2.length < 1000) { finished = true; break; }
        }
        if (!allRows.length) return json({ date: singleDate, savedIntraday: 0, savedDaily: 0, pages, empty: true });

        // sym → минута → {YUR, FIZ}; фильтр по списку тикеров, если не all=1
        const wanted = saveAll ? null : new Set(tickers.map(futoi2sym));
        const bySymTime = {};
        const lastOfDayBySym = {};
        for (const o of allRows) {
          const g = (o.clgroup || '').toUpperCase();
          if (g !== 'YUR' && g !== 'FIZ') continue;
          const s = o.ticker;
          if (wanted && !wanted.has(s)) continue;
          const tt = `${(o.tradetime || '00:00:00').slice(0, 5)}:00`;
          const k = `${s}__${tt}`;
          (bySymTime[k] = bySymTime[k] || { sym: s, tt })[g] = o;
          if (!lastOfDayBySym[s] || tt > lastOfDayBySym[s].tt) lastOfDayBySym[s] = { tt, k };
        }
        const hourlyStmts = [];
        for (const rec of Object.values(bySymTime)) {
          if (parseInt(rec.tt.slice(3, 5), 10) % stepMin !== 0) continue;
          const ts = new Date(`${singleDate}T${rec.tt}+03:00`).getTime();
          if (!isFinite(ts)) continue;
          const Y = rec.YUR, F = rec.FIZ;
          hourlyStmts.push(db.prepare(
            `INSERT OR REPLACE INTO oi_hourly
               (key,ticker,ts,price,yur_long,yur_short,fiz_long,fiz_short,
                yur_long_num,yur_short_num,fiz_long_num,fiz_short_num)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(
            `${rec.sym}__${singleDate}__${rec.tt}`, rec.sym, ts, 0,
            Number(Y?.pos_long || 0), Math.abs(Number(Y?.pos_short || 0)),
            Number(F?.pos_long || 0), Math.abs(Number(F?.pos_short || 0)),
            Number(Y?.pos_long_num || 0), Number(Y?.pos_short_num || 0),
            Number(F?.pos_long_num || 0), Number(F?.pos_short_num || 0),
          ));
        }
        for (let i = 0; i < hourlyStmts.length; i += 80) await db.batch(hourlyStmts.slice(i, i + 80));

        // Дневной итог (последний срез дня каждого sym) — батчем, а не по одному.
        // Только из первого чанка даты: страницы идут от конца дня к началу,
        // последний срез дня есть лишь при pstart=0 — продолжение даты
        // затёрло бы oi_daily более ранним временем
        const dailyStmts = pstart > 0 ? [] : Object.entries(lastOfDayBySym).map(([s, { k }]) => {
          const rec = bySymTime[k];
          const Y = rec.YUR, F = rec.FIZ;
          return db.prepare(
            `INSERT OR REPLACE INTO oi_daily
               (key,ticker,tradedate,price,yur_long,yur_short,fiz_long,fiz_short,
                yur_long_num,yur_short_num,fiz_long_num,fiz_short_num,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(
            `${s}__${singleDate}`, s, singleDate, 0,
            Number(Y?.pos_long || 0), Math.abs(Number(Y?.pos_short || 0)),
            Number(F?.pos_long || 0), Math.abs(Number(F?.pos_short || 0)),
            Number(Y?.pos_long_num || 0), Number(Y?.pos_short_num || 0),
            Number(F?.pos_long_num || 0), Number(F?.pos_short_num || 0),
            Date.now(),
          );
        });
        for (let i = 0; i < dailyStmts.length; i += 80) await db.batch(dailyStmts.slice(i, i + 80));

        return json({ date: singleDate, pages, rows: allRows.length,
          savedIntraday: hourlyStmts.length, savedDaily: dailyStmts.length,
          nextPstart: finished ? null : start2 });
      } catch (e) {
        return json({ date: singleDate, savedIntraday: 0, failed: 1, error: e.message }, 500);
      }
    }

    if (singleDate) {
      const moexKey = env.MOEX_KEY;
      // Один запрос — весь снэпшот сессии (все тикеры в одном ответе)
      const anyRef = saveAll ? 'SS' : futoi2sym(tickers[0]);
      try {
        const url2 = `https://apim.moex.com/iss/analyticalproducts/futoi/securities.json?ticker=${encodeURIComponent(anyRef)}&date=${singleDate}&iss.meta=off&limit=10000`;
        const resp = await fetch(url2, { headers: { Authorization: `Bearer ${moexKey}`, Accept: 'application/json' } });
        if (!resp.ok) return json({ date: singleDate, saved: 0, empty: 0, failed: 1, httpStatus: resp.status });
        const json2 = await resp.json();
        const block = json2.futoi || json2[Object.keys(json2).find(k => k !== 'metadata' && k !== 'history')];
        const allRows = issBlockToObjects(block);

        // Группируем sym → clgroup → лучшая запись по tradetime
        const bySym = {};
        allRows.forEach(o => {
          const g = (o.clgroup || '').toUpperCase();
          if (g !== 'YUR' && g !== 'FIZ') return;
          const s = o.ticker;
          if (!bySym[s]) bySym[s] = {};
          if (!bySym[s][g] || (o.tradetime || '') > (bySym[s][g].tradetime || '')) bySym[s][g] = o;
        });

        let saved = 0, empty = 0;
        const upserts = [];

        if (saveAll) {
          // Сохраняем каждый sym как есть — ticker = sym (2-буквенный код)
          for (const [sym, byGroup] of Object.entries(bySym)) {
            if (!byGroup.YUR && !byGroup.FIZ) { empty++; continue; }
            const tradedate = (byGroup.YUR || byGroup.FIZ).tradedate || singleDate;
            upserts.push(upsertOiDaily(db, {
              ticker: sym, tradedate, price: 0,
              yur_long: Number(byGroup.YUR?.pos_long || 0),
              yur_short: Math.abs(Number(byGroup.YUR?.pos_short || 0)),
              fiz_long: Number(byGroup.FIZ?.pos_long || 0),
              fiz_short: Math.abs(Number(byGroup.FIZ?.pos_short || 0)),
              yur_long_num: Number(byGroup.YUR?.pos_long_num || 0),
              yur_short_num: Number(byGroup.YUR?.pos_short_num || 0),
              fiz_long_num: Number(byGroup.FIZ?.pos_long_num || 0),
              fiz_short_num: Math.abs(Number(byGroup.FIZ?.pos_short_num || 0)),
            }));
            saved++;
          }
        } else {
          // Строим map sym→[тикеры] и фильтруем только запрошенные
          const symMap = {};
          for (const ticker of tickers) {
            const sym = futoi2sym(ticker);
            (symMap[sym] = symMap[sym] || []).push(ticker);
          }
          for (const [sym, tickerList] of Object.entries(symMap)) {
            const byGroup = bySym[sym] || {};
            if (!byGroup.YUR && !byGroup.FIZ) { empty += tickerList.length; continue; }
            const tradedate = (byGroup.YUR || byGroup.FIZ).tradedate || singleDate;
            for (const ticker of tickerList) {
              upserts.push(upsertOiDaily(db, {
                ticker, tradedate, price: 0,
                yur_long: Number(byGroup.YUR?.pos_long || 0),
                yur_short: Math.abs(Number(byGroup.YUR?.pos_short || 0)),
                fiz_long: Number(byGroup.FIZ?.pos_long || 0),
                fiz_short: Math.abs(Number(byGroup.FIZ?.pos_short || 0)),
                yur_long_num: Number(byGroup.YUR?.pos_long_num || 0),
                yur_short_num: Number(byGroup.YUR?.pos_short_num || 0),
                fiz_long_num: Number(byGroup.FIZ?.pos_long_num || 0),
                fiz_short_num: Math.abs(Number(byGroup.FIZ?.pos_short_num || 0)),
              }));
              saved++;
            }
          }
        }
        await Promise.all(upserts);
        return json({ date: singleDate, saved, empty, failed: 0 });
      } catch(e) {
        return json({ date: singleDate, saved: 0, empty: 0, failed: 1, error: e.message });
      }
    }

    const days = Math.min(Number(u.searchParams.get('days')) || 90, 365);
    // step= — шаг интрадей-снэпшотов в минутах (5/10/30/60); 30 по умолчанию,
    // чтобы за 100 дней не упереться в лимит сабзапросов на батчах записи
    const step = Math.max(5, Math.min(Number(u.searchParams.get('step')) || 30, 60));
    // start= — оффсет пагинации из nextStart предыдущего ответа (возобновление);
    // pages= — бюджет страниц на вызов (25 по умолчанию: помещается в лимит
    // 50 сабзапросов бесплатного плана вместе с батчами записи)
    const startOffset = Math.max(0, Number(u.searchParams.get('start')) || 0);
    const maxPages = Math.max(1, Math.min(Number(u.searchParams.get('pages')) || 25, 40));
    // till= — фиксация правой границы цепочки (из ответа первого вызова):
    // start-offset валиден только при неизменном till
    const tillOverride = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('till') || '') ? u.searchParams.get('till') : null;
    const result = await backfillOiHistory(db, env, tickers, days, step, startOffset, maxPages, tillOverride);
    return json(result);
  }

  // ── Ретроактивный бэкфилл цены для root-тикера (2-буквенный код из all=1) ──
  // oi_daily для root всегда пишется с price=0 (FutOI отдаёт ОИ на уровне
  // серии, без цены) — но история ОИ там при этом полная (напр. 114 дней).
  // Цену для каждой даты нужно взять у КОНКРЕТНОГО дескрипта, который был
  // front-month в этот день — а мы заранее не знаем полный список дескриптов
  // серии: в oi_daily попадают только те, что наш cron когда-либо отслеживал
  // (обычно последние 1-3 недели). Экспирировавшие контракты, которые
  // торговались раньше, там вообще не появляются.
  // Решение: ищем ВСЕ фьючерсы этой серии напрямую через T-Invest
  // FindInstrument по префиксу root (а не по тому, что уже есть в нашей БД),
  // качаем полную дневную историю свечей по каждому найденному дескрипту и
  // проставляем price в oi_daily root-тикера там, где нашлось совпадение по дате.
  // /db/oidaily/backfillprice?ticker=AF
  if (p === '/oidaily/backfillprice' && req.method === 'GET') {
    const u = new URL(req.url);
    const rootTicker = u.searchParams.get('ticker');
    if (!rootTicker) return json({ error: 'ticker required' }, 400);
    const token = env.TINVEST_TOKEN;
    if (!token) return json({ error: 'TINVEST_TOKEN secret не задан' }, 503);

    const { results: rootRows } = await db.prepare(
      'SELECT tradedate FROM oi_daily WHERE ticker=? ORDER BY tradedate ASC'
    ).bind(rootTicker).all();
    if (!rootRows.length) return json({ error: `нет данных oi_daily для ${rootTicker}` }, 404);
    const fromDate = rootRows[0].tradedate, toDate = rootRows[rootRows.length - 1].tradedate;

    let contracts;
    try {
      const fr = await fetch('https://invest-public-api.tinkoff.ru/rest/tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: rootTicker, instrumentKind: 'INSTRUMENT_TYPE_FUTURES', apiTradeAvailableFlag: false }),
      });
      if (!fr.ok) return json({ error: `T-Invest FindInstrument HTTP ${fr.status}` }, 502);
      const fb = await fr.json();
      const rootRe = new RegExp(`^${rootTicker}[FGHJKMNQUVXZ]\\d$`, 'i');
      contracts = (fb.instruments || []).filter(i => rootRe.test(i.ticker || ''));
    } catch(e) {
      return json({ error: 'FindInstrument: ' + e.message }, 502);
    }
    if (!contracts.length) {
      return json({ ticker: rootTicker, error: 'T-Invest не нашёл дескриптов этой серии', contractsFound: [], updated: 0 });
    }

    const priceOf = f => (f?.units ? Number(f.units) + (f.nano || 0) / 1e9 : 0);
    const priceByDate = {}; // date -> {price, vol} — при пересечении дескриптов берём больший объём
    const contractsUsed = [];
    for (const inst of contracts) {
      try {
        const resp = await fetch('https://invest-public-api.tinkoff.ru/rest/tinkoff.public.invest.api.contract.v1.MarketDataService/GetCandles', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ figi: inst.figi, from: new Date(fromDate).toISOString(), to: new Date(toDate + 'T23:59:59Z').toISOString(), interval: 'CANDLE_INTERVAL_DAY' }),
        });
        if (!resp.ok) continue;
        const body = await resp.json();
        const candles = body.candles || [];
        if (!candles.length) continue;
        contractsUsed.push(inst.ticker);
        const rows = candles.map(c => {
          const ts = Math.floor(new Date(c.time).getTime() / 1000);
          return { key: `${inst.ticker}__day__${ts}`, ticker: inst.ticker, tf: 'day', time: ts,
                   o: priceOf(c.open), h: priceOf(c.high), l: priceOf(c.low), cl: priceOf(c.close), vol: c.volume ?? 0 };
        });
        // Заодно сохраняем свечи этого дескрипта в candles — пригодятся при
        // прямых запросах по нему (без повторного похода в T-Invest).
        for (let i = 0; i < rows.length; i += 100) {
          const chunk = rows.slice(i, i + 100);
          await db.batch(chunk.map(r =>
            db.prepare('INSERT OR REPLACE INTO candles(key,ticker,tf,time,o,h,l,cl,vol) VALUES(?,?,?,?,?,?,?,?,?)')
              .bind(r.key, r.ticker, r.tf, r.time, r.o, r.h, r.l, r.cl, r.vol)
          ));
        }
        for (const r of rows) {
          const date = new Date(r.time * 1000).toISOString().slice(0, 10);
          const existing = priceByDate[date];
          if (!existing || r.vol > existing.vol) priceByDate[date] = { price: r.cl, vol: r.vol };
        }
      } catch(e) { /* этот дескрипт не подтянулся — пробуем остальные */ }
    }

    const dates = Object.keys(priceByDate);
    for (let i = 0; i < dates.length; i += 50) {
      const chunk = dates.slice(i, i + 50);
      await db.batch(chunk.map(date =>
        db.prepare('UPDATE oi_daily SET price=? WHERE ticker=? AND tradedate=?')
          .bind(priceByDate[date].price, rootTicker, date)
      ));
    }

    return json({
      ticker: rootTicker, datesTotal: rootRows.length, datesPriced: dates.length,
      contractsFound: contracts.map(c => c.ticker), contractsUsed,
    });
  }

  // ── Классификация тикера по типу базового актива через T-Invest ──
  // Биржа сама делит фьючерсы на акции/валюту/товар/индекс — не нужно
  // опознавать полсотни root-тикеров вручную. FindInstrument даёт только
  // краткую карточку без asset_type, поэтому берём первый живой дескрипт
  // серии и дальше запрашиваем полную карточку через FutureBy.
  // Один тикер за вызов (не batch по всем сразу): Cloudflare Workers режет
  // число сабзапросов ЗА ОДНО инвокейшн (лимит на free-плане — 50), а тут
  // на тикер уходит 2 сабзапроса — на полсотне тикеров разом лимит вылетал
  // с ошибкой "Too many subrequests". Фронтенд теперь дергает эндпоинт в
  // цикле, по тикеру за раз — это уже отдельные инвокейшны воркера.
  // /db/instruments/assetclass?ticker=AF
  if (p === '/instruments/assetclass' && req.method === 'GET') {
    const u = new URL(req.url);
    const rootTicker = u.searchParams.get('ticker');
    if (!rootTicker) return json({ error: 'ticker required' }, 400);
    const token = env.TINVEST_TOKEN;
    if (!token) return json({ error: 'TINVEST_TOKEN secret не задан' }, 503);

    // Реальные значения из T-Invest — БЕЗ префикса ASSET_TYPE_ (в отличие от
    // большинства других enum'ов этого API) — уточнено по живому ответу.
    const ASSET_TYPE_LABELS = {
      TYPE_SECURITY: 'акция', TYPE_CURRENCY: 'валюта',
      TYPE_COMMODITY: 'товар', TYPE_INDEX: 'индекс',
    };

    try {
      const fr = await fetch('https://invest-public-api.tinkoff.ru/rest/tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: rootTicker, instrumentKind: 'INSTRUMENT_TYPE_FUTURES', apiTradeAvailableFlag: false }),
      });
      if (!fr.ok) return json({ ticker: rootTicker, error: `FindInstrument HTTP ${fr.status}` });
      const fb = await fr.json();
      const rootRe = new RegExp(`^${rootTicker}[FGHJKMNQUVXZ]\\d$`, 'i');
      const contract = (fb.instruments || []).find(i => rootRe.test(i.ticker || ''));
      if (!contract) return json({ ticker: rootTicker, error: 'дескрипт серии не найден' });

      const br = await fetch('https://invest-public-api.tinkoff.ru/rest/tinkoff.public.invest.api.contract.v1.InstrumentsService/FutureBy', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ idType: 'INSTRUMENT_ID_TYPE_FIGI', id: contract.figi }),
      });
      if (!br.ok) return json({ ticker: rootTicker, error: `FutureBy HTTP ${br.status}` });
      const bb = await br.json();
      const inst = bb.instrument || {};
      return json({
        ticker: rootTicker, contract: contract.ticker,
        assetType: inst.assetType || null,
        assetClass: ASSET_TYPE_LABELS[inst.assetType] || null,
        basicAsset: inst.basicAsset || null,
      });
    } catch(e) {
      return json({ ticker: rootTicker, error: e.message }, 502);
    }
  }

  return json({ error: 'unknown db route: ' + p }, 404);
}

// ── Main Handler ───────────────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledCollectOi(env).catch(e => console.error('oi cron failed:', e.message)));
  },

  async fetch(req, env) {
    const url  = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS });

    if (path.startsWith('/db/') || path === '/db')
      return handleDb(path, req, env).catch(e => json({ error: e.message }, 500));

    const fullPath = path + url.search;

    // MOEX AlgoPack: /iss/datashop/algopack/... и /iss/analyticalproducts/futoi/...
    if (path.startsWith('/iss/')) {
      const auth = req.headers.get('Authorization') || '';
      const resp = await fetch('https://apim.moex.com' + fullPath, {
        headers: { 'Authorization': auth, 'Accept': 'application/json' },
      });
      return new Response(resp.body, {
        status: resp.status,
        headers: { ...CORS, 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
      });
    }

    // T-Invest
    if (path.startsWith('/tinkoff')) {
      const auth = req.headers.get('Authorization') || '';
      const body = req.method === 'POST' ? await req.arrayBuffer() : undefined;
      const resp = await fetch('https://invest-public-api.tinkoff.ru/rest' + fullPath, {
        method: req.method,
        headers: { 'Authorization': auth, 'Content-Type': req.headers.get('Content-Type') || 'application/json' },
        body,
      });
      return new Response(resp.body, {
        status: resp.status,
        headers: { ...CORS, 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
      });
    }

    // БондАналитик — CORS-прокси
    let target = url.searchParams.get('u');

    const ALLOWED = [
      /^https:\/\/bo\.nalog\.gov\.ru\//,
      /^https:\/\/(www\.)?audit-it\.ru\//,
      /^https:\/\/(www\.)?buxbalans\.ru\//,
      /^https:\/\/(www\.)?cbr\.ru\/dataservice\//,
      /^https:\/\/(www\.)?cbr\.ru\/Content\/Document\/File\//,
      /^https:\/\/api\.stlouisfed\.org\/fred\//,
      /^https:\/\/query[12]\.finance\.yahoo\.com\//,
      /^https:\/\/stooq\.com\//,
      /^https:\/\/data-api\.ecb\.europa\.eu\//,
    ];

    if (!target) {
      if (path.startsWith('/nbo') || path.startsWith('/advanced-search'))
        target = 'https://bo.nalog.gov.ru' + fullPath;
      else if (path.startsWith('/buh_otchet') || path.startsWith('/search') || path.startsWith('/contragent'))
        target = 'https://www.audit-it.ru' + fullPath;
      else if (path.startsWith('/dataservice') || path.startsWith('/Content/Document/File/'))
        target = 'https://www.cbr.ru' + fullPath;
      else if (path.startsWith('/fred/'))
        target = 'https://api.stlouisfed.org' + fullPath;
      else if (path.startsWith('/v7/finance/') || path.startsWith('/v8/finance/'))
        target = 'https://query1.finance.yahoo.com' + fullPath;
      else if (path.startsWith('/q/d/l/'))
        target = 'https://stooq.com' + fullPath;
      else if (/^\/\d{10}(\d{2})?\.html$/.test(path))
        target = 'https://buxbalans.ru' + fullPath;
    }

    if (!target || !ALLOWED.some(re => re.test(target)))
      return new Response('Bad request', { status: 400, headers: CORS });

    if (req.method !== 'GET' && req.method !== 'HEAD')
      return new Response('Method not allowed', { status: 405, headers: CORS });

    try {
      let upstream = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          upstream = await fetch(target, {
            method: req.method,
            headers: {
              'Accept': target.includes('cbr.ru/dataservice') || target.includes('api.stlouisfed.org') || target.includes('finance.yahoo.com')
                ? 'application/json, */*;q=0.1'
                : target.includes('stooq.com') ? 'text/csv, text/plain, */*;q=0.1'
                : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.7',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
              'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
              ...(target.includes('audit-it.ru') ? { 'Referer': 'https://www.audit-it.ru/' } : {}),
            },
            cf: { cacheTtl: 600, cacheTtlByStatus: { '200-299': 600, '300-599': 0 } },
          });
          if (![502, 503, 504, 522, 524].includes(upstream.status)) break;
        } catch (_) {}
        if (attempt < 2) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      }
      if (!upstream) return new Response('Upstream unreachable', { status: 502, headers: CORS });

      const hdrs = new Headers(upstream.headers);
      Object.entries(CORS).forEach(([k, v]) => hdrs.set(k, v));
      hdrs.delete('Set-Cookie');
      hdrs.delete('Strict-Transport-Security');
      hdrs.set('Cache-Control', upstream.status < 300 ? 'public, max-age=600' : 'no-store');
      return new Response(upstream.body, { status: upstream.status, headers: hdrs });
    } catch (e) {
      return new Response('Error: ' + e.message, { status: 502, headers: CORS });
    }
  },
};
