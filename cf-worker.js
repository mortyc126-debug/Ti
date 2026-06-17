// Cloudflare Worker — CORS-прокси + D1 для OI·INTEL
//
// Binding: интерес → D1 database oi_signal1
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
//   /db/oidaily                       POST — upsert дневной снэпшок ОИ (юр/физ, лонг/шорт, цена)
//   /db/oidaily?ticker=               GET  — вся история снэпшотов тикера (для слоёв позиций)
//   /db/oibackfill?tickers=&days=     GET  — разовый backfill истории FutOI юр/физ за прошлые
//                                            даты (date= в futoi API); без tickers — берёт
//                                            текущий отслеживаемый список из oi_tracked_state
//
// Cron (scheduled): ежедневный автосбор oi_daily по всем ликвидным фьючерсам
// FORTS — без участия браузера. Настройка:
//   1. Cloudflare Dashboard → Workers → этот воркер → Settings → Variables →
//      добавить secret MOEX_KEY (тот же ключ, что в поле "MOEX API key" в приложении).
//   2. Settings → Triggers → Cron Triggers → добавить, например "30 7 * * *"
//      (07:30 UTC = после закрытия вечерней сессии FORTS).
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

const DB = env => env.интерес;

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
    key        TEXT PRIMARY KEY,
    ticker     TEXT NOT NULL,
    tradedate  TEXT NOT NULL,
    price      REAL DEFAULT 0,
    yur_long   REAL DEFAULT 0,
    yur_short  REAL DEFAULT 0,
    fiz_long   REAL DEFAULT 0,
    fiz_short  REAL DEFAULT 0,
    updated_at INTEGER DEFAULT 0
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
];

// ── D1 Route Handler ───────────────────────────────────────────────────────
// ── Upsert одного снэпшока в oi_daily (общий код для /db/oidaily и cron) ──
async function upsertOiDaily(db, r) {
  await db.prepare(
    `INSERT OR REPLACE INTO oi_daily(key,ticker,tradedate,price,yur_long,yur_short,fiz_long,fiz_short,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)`
  ).bind(
    `${r.ticker}__${r.tradedate}`, r.ticker, r.tradedate, r.price ?? 0,
    r.yur_long ?? 0, r.yur_short ?? 0, r.fiz_long ?? 0, r.fiz_short ?? 0, Date.now()
  ).run();
}

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

  // 4. По каждому отобранному тикеру — FutOI (apim, нужен ключ) + цена из
  // securities.json — и сохраняем дневной снэпшок. Чанками, чтобы не упереться
  // в лимиты конкурентных запросов воркера.
  const CHUNK = 6;
  for (let i = 0; i < finalTickers.length; i += CHUNK) {
    const chunk = finalTickers.slice(i, i + CHUNK);
    await Promise.all(chunk.map(async r => {
      try {
        const sym = futoi2sym(r.ticker);
        const url = `https://apim.moex.com/iss/analyticalproducts/futoi/securities.json?ticker=${encodeURIComponent(sym)}&iss.meta=off&limit=1000`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${moexKey}`, Accept: 'application/json' } });
        if (!resp.ok) return;
        const json2 = await resp.json();
        const block = json2.futoi || json2[Object.keys(json2).find(k => k !== 'metadata' && k !== 'history')];
        const rows = issBlockToObjects(block).filter(o => o.ticker === sym);
        if (!rows.length) return;
        const byGroup = {};
        rows.forEach(o => {
          const g = (o.clgroup || '').toUpperCase();
          if (g !== 'YUR' && g !== 'FIZ') return;
          if (!byGroup[g] || (o.tradetime || '') > (byGroup[g].tradetime || '')) byGroup[g] = o;
        });
        const date = (byGroup.YUR || byGroup.FIZ || {}).tradedate || today;
        await upsertOiDaily(db, {
          ticker: r.ticker, tradedate: date, price: r.price,
          yur_long: Number(byGroup.YUR?.pos_long || 0),
          yur_short: Math.abs(Number(byGroup.YUR?.pos_short || 0)),
          fiz_long: Number(byGroup.FIZ?.pos_long || 0),
          fiz_short: Math.abs(Number(byGroup.FIZ?.pos_short || 0)),
        });
      } catch (e) { console.warn('oi cron:', r.ticker, e.message); }
    }));
  }
}

// ── Backfill: разовая подтяжка истории FutOI (юр/физ) за прошлые даты ──
// futoi/securities.json принимает date= и отдаёт срез на конкретный день,
// поэтому глубину истории тянем циклом по датам (а не диапазоном за раз).
// Глубина ограничена тарифом подписки на стороне MOEX — сколько дней реально
// отдаст API, узнаём только по факту (где данных не будет, просто пропустим).
async function backfillOiHistory(db, env, tickers, days) {
  const moexKey = env.MOEX_KEY;
  if (!moexKey) return { error: 'secret MOEX_KEY не задан' };
  const dates = [];
  const d = new Date();
  for (let i = 0; i < days; i++) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() - 1);
  }
  let saved = 0, empty = 0, failed = 0;
  for (const ticker of tickers) {
    const sym = futoi2sym(ticker);
    for (const date of dates) {
      try {
        const url = `https://apim.moex.com/iss/analyticalproducts/futoi/securities.json?ticker=${encodeURIComponent(sym)}&date=${date}&iss.meta=off&limit=1000`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${moexKey}`, Accept: 'application/json' } });
        if (!resp.ok) { failed++; continue; }
        const json2 = await resp.json();
        const block = json2.futoi || json2[Object.keys(json2).find(k => k !== 'metadata' && k !== 'history')];
        const rows = issBlockToObjects(block).filter(o => o.ticker === sym);
        if (!rows.length) { empty++; continue; }
        const byGroup = {};
        rows.forEach(o => {
          const g = (o.clgroup || '').toUpperCase();
          if (g !== 'YUR' && g !== 'FIZ') return;
          if (!byGroup[g] || (o.tradetime || '') > (byGroup[g].tradetime || '')) byGroup[g] = o;
        });
        const tradedate = (byGroup.YUR || byGroup.FIZ || {}).tradedate || date;
        await upsertOiDaily(db, {
          ticker, tradedate, price: 0,
          yur_long: Number(byGroup.YUR?.pos_long || 0),
          yur_short: Math.abs(Number(byGroup.YUR?.pos_short || 0)),
          fiz_long: Number(byGroup.FIZ?.pos_long || 0),
          fiz_short: Math.abs(Number(byGroup.FIZ?.pos_short || 0)),
        });
        saved++;
      } catch (e) { failed++; }
    }
  }
  return { tickers: tickers.length, days, saved, empty, failed };
}

async function handleDb(path, req, env) {
  const db = DB(env);
  if (!db) return json({ error: 'D1 binding "интерес" не настроен' }, 503);

  const p = path.replace(/^\/db/, '');

  // ── Init ──
  if (p === '/init') {
    for (const stmt of SCHEMA_STMTS) {
      await db.prepare(stmt).run();
    }
    return json({ ok: true, msg: 'schema ready (v2 — adaptive)' });
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

  if (p.startsWith('/candles') && req.method === 'GET') {
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

  if (p.startsWith('/oidaily') && req.method === 'GET') {
    const ticker = new URL(req.url).searchParams.get('ticker');
    if (!ticker) return json({ error: 'ticker required' }, 400);
    const { results } = await db.prepare(
      'SELECT * FROM oi_daily WHERE ticker=? ORDER BY tradedate ASC'
    ).bind(ticker).all();
    return json(results);
  }

  // ── Разовый backfill истории FutOI: /db/oibackfill?tickers=BRN6,SiU6&days=90 ──
  // Без tickers — берёт текущий отслеживаемый список из oi_tracked_state.
  if (p === '/oibackfill' && req.method === 'GET') {
    const u = new URL(req.url);
    const days = Math.min(Number(u.searchParams.get('days')) || 90, 365);
    let tickers = (u.searchParams.get('tickers') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!tickers.length) {
      const { results } = await db.prepare('SELECT ticker FROM oi_tracked_state WHERE tracked=1').all();
      tickers = results.map(r => r.ticker);
    }
    if (!tickers.length) return json({ error: 'нет тикеров: пусто и в параметре, и в oi_tracked_state (запусти cron хотя бы раз)' }, 400);
    const result = await backfillOiHistory(db, env, tickers, days);
    return json(result);
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
