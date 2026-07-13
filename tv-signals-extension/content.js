/* content.js — «Сигнальные модели» поверх TradingView в Тинькофф-терминале.
 * Работает в MAIN-мире верхней страницы: тянется до графика через
 * iframe.contentWindow.tradingViewApi, берёт свечи из exportData(), считает
 * методы (SignalsCore) и рисует сигналы НАТИВНЫМИ фигурами (createShape),
 * привязанными к цене/времени. Панель показывает сигнал + точность по тикеру.
 * v1: без токена (данные из графика). Объёмные методы деградируют, если в
 * exportData нет объёма. */
(function () {
  'use strict';
  if (window.__tvSignals) return;

  const META = [
    ['zscore', 'Z-score', '#4CC9F0'], ['accel', 'Accel-fade', '#F72585'],
    ['order_block', 'Order Block', '#FFB703'], ['fvg', 'FVG', '#8AC926'],
    ['liq_sweep', 'Liquidity Sweep', '#FF6B6B'], ['false_breakout', 'False Breakout', '#B197FC'],
    ['vsa_abs', 'VSA Absorption', '#52D8A0'], ['waning', 'Waning', '#FF9F40'],
    ['talib_anti', 'Фейд свечей', '#E36414'], ['hawkes', 'Hawkes', '#00BBF9'],
    ['cascade', 'Cascade', '#F15BB5'], ['nw', 'NW-память', '#9B5DE5'],
  ];
  const NAME = {}, DEF_COLOR = {}; META.forEach(([id, n, c]) => { NAME[id] = n; DEF_COLOR[id] = c; });
  const PREF = 'tvsig:on', CKEY = 'tvsig:colors', SKEY = 'tvsig:stats';

  const S = {
    api: null, chart: null, bars: [], symbol: '', res: null,
    on: loadPref(), colors: loadColors(), drawn: {}, // id -> [shapeId]
    computed: null, busy: false, hasVolume: null, oi: null,
    statsCache: loadStats(), lastBarTime: 0, statsTs: 0, // exp/winrate по тикеру
  };
  const OI_BASE_DEF = 'https://oi.marginacall.workers.dev';
  function oiBase() { try { return localStorage.getItem('tvsig:oibase') || OI_BASE_DEF; } catch (e) { return OI_BASE_DEF; } }
  // мост в isolated-world (oi-bridge.js) — обход CSP терминала на фетч воркера
  function oiFetch(url, headers) {
    return new Promise(resolve => {
      const id = 'oi' + Math.random().toString(36).slice(2);
      function onRes(e) { let r; try { r = JSON.parse(e.detail); } catch (_) { return; } if (r.id !== id) return; window.removeEventListener('tvsig:oi:res', onRes); resolve(r); }
      window.addEventListener('tvsig:oi:res', onRes);
      window.dispatchEvent(new CustomEvent('tvsig:oi:req', { detail: JSON.stringify({ id, url, headers: headers || null }) }));
      setTimeout(() => { window.removeEventListener('tvsig:oi:res', onRes); resolve({ ok: false, error: 'timeout' }); }, 12000);
    });
  }
  // токен AlgoPack (MOEX) — хранится локально, шлётся ТОЛЬКО в apim.moex.com
  function oiTokenGet() { try { return localStorage.getItem('tvsig:moextoken') || ''; } catch (e) { return ''; } }
  function oiTokenSet(v) { try { v ? localStorage.setItem('tvsig:moextoken', v) : localStorage.removeItem('tvsig:moextoken'); } catch (e) {} }
  // ISS columnar {columns,data} → массив объектов
  function issToObjects(block) {
    if (!block || !block.columns || !block.data) return [];
    return block.data.map(row => { const o = {}; block.columns.forEach((c, i) => o[c] = row[i]); return o; });
  }
  // Живой снэпшот физ/юр по контракту напрямую из AlgoPack (нужен токен).
  // Возвращает {ok, snap:{ts,fl,fs,yl,ys}, syms} или {ok:false, error, syms}.
  async function oiLiveSnap(candidates) {
    const tok = oiTokenGet(); if (!tok) return { ok: false, error: 'no-token' };
    const url = 'https://apim.moex.com/iss/analyticalproducts/futoi/securities.json?iss.meta=off&limit=5000';
    const r = await oiFetch(url, { Authorization: 'Bearer ' + tok });
    if (!r.ok) return { ok: false, error: r.error || 'fetch' };
    let j; try { j = JSON.parse(r.json); } catch (_) { return { ok: false, error: 'parse' }; }
    const key = Object.keys(j).find(k => k !== 'metadata' && k !== 'history') || 'futoi';
    const rows = issToObjects(j[key]);
    const syms = [...new Set(rows.map(o => String(o.ticker || '').toUpperCase()))];
    // ищем sym среди кандидатов (полный код, 2-буквенный, и то что вернул сервер)
    let pick = null;
    for (const c of candidates) { const cu = c.toUpperCase(); if (syms.indexOf(cu) >= 0) { pick = cu; break; }
      const hit = syms.find(s => cu.indexOf(s) === 0 || s.indexOf(cu) === 0); if (hit) { pick = hit; break; } }
    if (!pick) return { ok: false, error: 'sym-not-found', syms };
    const grp = {};
    for (const o of rows) { if (String(o.ticker).toUpperCase() !== pick) continue; const g = String(o.clgroup || '').toUpperCase(); if (g === 'YUR' || g === 'FIZ') grp[g] = o; }
    const Y = grp.YUR || {}, F = grp.FIZ || {};
    const snap = { ts: Math.floor(Date.now() / 1000),
      yl: +(Y.pos_long || 0), ys: Math.abs(+(Y.pos_short || 0)), fl: +(F.pos_long || 0), fs: Math.abs(+(F.pos_short || 0)) };
    return { ok: true, snap: { ts: snap.ts, fl: snap.fl, fs: snap.fs, yl: snap.yl, ys: snap.ys }, sym: pick };
  }
  // накопленная live-серия по контракту (localStorage) — из неё Δ по региону
  function oiAccKey(sym) { return 'tvsig:oiacc:' + sym; }
  function oiAccLoad(sym) { try { return JSON.parse(localStorage.getItem(oiAccKey(sym)) || '[]'); } catch (e) { return []; } }
  function oiAccPush(sym, snap) {
    let arr = oiAccLoad(sym);
    if (arr.length && Math.abs(arr[arr.length - 1].ts - snap.ts) < 60) arr[arr.length - 1] = snap; // тот же снэпшот
    else arr.push(snap);
    if (arr.length > 600) arr = arr.slice(-600);
    try { localStorage.setItem(oiAccKey(sym), JSON.stringify(arr)); } catch (e) {}
    return arr;
  }
  function oiNormalize(r) {
    let ts, label;
    if (r.ts != null) { ts = Number(r.ts) / 1000; const d = new Date(ts * 1000); // oi_hourly: 5-мин, unix ms
      label = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
    else { ts = (Date.parse(String(r.tradedate || r.date || '').replace(' ', 'T')) / 1000) || 0; label = r.tradedate || r.date || ''; }
    return { date: label, ts, fl: +(r.fiz_long || 0), fs: +(r.fiz_short || 0), yl: +(r.yur_long || 0), ys: +(r.yur_short || 0) };
  }
  function oiCands() {
    let sym = ''; try { sym = S.chart.symbol(); } catch (e) {}
    const ov = ((document.getElementById('tvsig-oi-tk') || {}).value || '').trim().toUpperCase();
    const cands = []; if (ov) cands.push(ov);
    if (sym) { const u = sym.toUpperCase(); if (cands.indexOf(u) < 0) cands.push(u); const m = u.match(/^([A-Z]{2})/); if (m && cands.indexOf(m[1]) < 0) cands.push(m[1]); }
    return cands;
  }
  async function oiWorkerSeries(cands) { // архив из воркера (5-мин oihourly → дневной)
    for (const c of cands) for (const ep of [['oihourly', '&days=30', '5-мин'], ['oidaily', '', 'день']]) {
      const r = await oiFetch(oiBase() + '/db/' + ep[0] + '?ticker=' + encodeURIComponent(c) + ep[1]);
      if (!r.ok) continue;
      let arr; try { const j = JSON.parse(r.json); arr = Array.isArray(j) ? j : (j.rows || j.data || []); } catch (_) { arr = []; }
      const norm = arr.map(oiNormalize).filter(x => x.ts);
      if (norm.length) return { rows: norm.sort((a, b) => a.ts - b.ts), used: c, tf: ep[2] };
    }
    return null;
  }
  function oiMerge(a, b) { // объединяем по ts (сек), дедуп
    const map = {}; [...(a || []), ...(b || [])].forEach(r => { map[Math.round(r.ts)] = r; });
    return Object.values(map).sort((x, y) => x.ts - y.ts);
  }
  async function oiLoad() {
    if (!S.chart) return;
    const body = document.getElementById('tvsig-oi-body'); if (body && !S.oi) body.textContent = 'загрузка…';
    const cands = oiCands();
    if (!cands.length) { if (body) body.textContent = 'нет тикера'; return; }
    const tok = oiTokenGet();
    if (tok) {
      // ЖИВОЙ путь: снэпшот AlgoPack по токену + подсев архива из воркера + накопление
      const live = await oiLiveSnap(cands);
      if (live.ok) {
        let series = oiAccPush(live.sym, live.snap);
        if (!S._oiSeeded || S._oiSeeded !== live.sym) { // разово подмешиваем историю из воркера
          const w = await oiWorkerSeries([live.sym, ...cands]);
          if (w) series = oiMerge(w.rows.map(r => ({ ts: r.ts, fl: r.fl, fs: r.fs, yl: r.yl, ys: r.ys })), series);
          S._oiSeeded = live.sym;
        }
        const rows = series.map(r => { const d = new Date(r.ts * 1000); return { ...r, date: ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) }; });
        S.oi = { rows, used: live.sym, tf: '5-мин live' }; oiRender(); return;
      }
      if (live.error === 'sym-not-found') { if (body) body.innerHTML = '<span style="color:#b0873b">Контракт не найден в AlgoPack. Доступные коды: ' + (live.syms || []).slice(0, 40).join(', ') + '. Впиши нужный в поле кода.</span>'; return; }
      if (body) body.innerHTML = '<span style="color:#FF6B6B">AlgoPack: ' + (live.error || 'ошибка') + ' (проверь токен)</span>';
      return;
    }
    // без токена — только архив воркера (то, что коллектор уже собрал)
    const w = await oiWorkerSeries(cands);
    if (!w) { if (body) body.innerHTML = '<span style="color:#b0873b">OI не найден (' + cands.join(' / ') + '). Впиши код или задай токен AlgoPack (🔑) для живых данных.</span>'; S.oi = null; return; }
    S.oi = w; oiRender();
  }
  function oiRender() {
    const body = document.getElementById('tvsig-oi-body'); if (!body || !S.oi) return;
    const rows = S.oi.rows; let vr = null; try { vr = S.chart.getVisibleRange(); } catch (e) {}
    let reg = vr ? rows.filter(r => r.ts >= vr.from && r.ts <= vr.to) : rows;
    if (reg.length < 2) reg = rows; // в окне мало точек — берём весь диапазон
    const a = reg[0], b = reg[reg.length - 1];
    const num = v => Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'к' : v.toFixed(0);
    const dlt = v => (v > 0 ? '+' : v < 0 ? '−' : '') + num(Math.abs(v));
    const cell = (cur, d) => { const col = d > 0 ? '#52D8A0' : d < 0 ? '#FF6B6B' : '#9a94b8'; return '<b>' + num(cur) + '</b> <span style="color:' + col + '">' + dlt(d) + '</span>'; };
    body.innerHTML =
      '<div class="tvsig-oi-meta">' + S.oi.used + ' · ' + (S.oi.tf || '') + ' · ' + reg.length + ' точек (' + a.date + '…' + b.date + ')</div>' +
      '<table class="tvsig-oi-t"><tr><th></th><th>лонг</th><th>шорт</th></tr>' +
      '<tr><td>физ</td><td>' + cell(b.fl, b.fl - a.fl) + '</td><td>' + cell(b.fs, b.fs - a.fs) + '</td></tr>' +
      '<tr><td>юр</td><td>' + cell(b.yl, b.yl - a.yl) + '</td><td>' + cell(b.ys, b.ys - a.ys) + '</td></tr></table>';
  }
  function loadPref() { try { return JSON.parse(localStorage.getItem(PREF) || '{}'); } catch (e) { return {}; } }
  function savePref() { try { localStorage.setItem(PREF, JSON.stringify(S.on)); } catch (e) {} }
  function loadColors() { try { return Object.assign({}, DEF_COLOR, JSON.parse(localStorage.getItem(CKEY) || '{}')); } catch (e) { return Object.assign({}, DEF_COLOR); } }
  function saveColors() { try { localStorage.setItem(CKEY, JSON.stringify(S.colors)); } catch (e) {} }

  // ── статистика exp/winrate по тикеру: считается на его свечах, хранится
  //    per-symbol в localStorage, обновляется при закрытии нового бара ──────────
  function loadStats() { try { return JSON.parse(localStorage.getItem(SKEY) || '{}'); } catch (e) { return {}; } }
  function saveStats(sym, computed, bars) {
    if (!sym || !computed) return;
    const m = {}; // компактно: e=exp, a=acc(winrate), w=win-до-тейка, n=сделок
    META.forEach(([id]) => { const s = computed[id] && computed[id].stats; if (s) m[id] = { e: s.exp, a: s.acc, w: s.win, n: s.n }; });
    S.statsCache[sym] = { m, ts: Date.now(), bars: bars.length, t: bars.length ? bars[bars.length - 1].time : 0 };
    S.statsTs = S.statsCache[sym].ts;
    const keys = Object.keys(S.statsCache); // не разрастаться — держим последние ~300 тикеров
    if (keys.length > 300) keys.sort((a, b) => S.statsCache[a].ts - S.statsCache[b].ts).slice(0, keys.length - 300).forEach(k => delete S.statsCache[k]);
    try { localStorage.setItem(SKEY, JSON.stringify(S.statsCache)); } catch (e) {}
  }
  // мгновенно показать сохранённые цифры тикера, пока идёт свежий пересчёт
  function seedFromCache(sym) {
    const e = S.statsCache[sym];
    if (!e || !e.m) { S.computed = null; S.statsTs = 0; return; }
    const c = {};
    META.forEach(([id]) => { const x = e.m[id];
      c[id] = { last: 0, series: null, stats: x ? { exp: x.e, acc: x.a, win: x.w, n: x.n } : { exp: null, acc: null, win: null, n: 0 } }; });
    S.computed = c; S.statsTs = e.ts; renderRows();
  }
  function fmtAgo(ts) { if (!ts) return '—'; const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + 'с назад'; const m = Math.round(s / 60); if (m < 60) return m + 'м назад';
    return Math.round(m / 60) + 'ч назад'; }
  function setColor(id, val) { S.colors[id] = val; saveColors(); if (S.on[id]) drawMethod(id); renderRows(); }

  // ── доступ к TradingView ─────────────────────────────────────────────────────
  function getApi() {
    const frames = document.getElementsByTagName('iframe');
    for (let i = 0; i < frames.length; i++) {
      let w; try { w = frames[i].contentWindow; } catch (e) { continue; }
      if (w && w.tradingViewApi && typeof w.tradingViewApi.activeChart === 'function') return w.tradingViewApi;
    }
    return null;
  }
  function ready() {
    const api = getApi(); if (!api) return false;
    let c; try { c = api.activeChart(); } catch (e) { return false; }
    if (!c || typeof c.exportData !== 'function' || typeof c.createShape !== 'function') return false;
    S.api = api; S.chart = c; return true;
  }

  // ── данные + расчёт ──────────────────────────────────────────────────────────
  async function refresh(force) {
    if (S.busy || !S.chart) return;
    S.busy = true;
    try {
      let sym = ''; try { sym = S.chart.symbol(); } catch (e) {}
      const changed = sym !== S.symbol;
      if (changed) { clearAll(); S.symbol = sym; S.lastBarTime = 0; seedFromCache(sym); status('тикер ' + (sym || '?') + ' · пересчёт…'); }
      const res = await Promise.resolve(S.chart.exportData());
      let bars = window.SignalsCore.parseExport(res);
      if (bars.length > 3000) bars = bars.slice(-3000); // держим NW (O(n^2)) в узде
      const lastT = bars.length ? bars[bars.length - 1].time : 0;
      const newBar = lastT !== S.lastBarTime;
      // тот же тикер, новый бар не закрылся, есть живой расчёт → только освежаем «обновлено»
      if (!changed && !newBar && !force && S.computed && S.computed.__live) {
        status('тикер ' + (S.symbol || '?') + ' · ' + S.bars.length + ' баров · обновлено ' + fmtAgo(S.statsTs));
        S.busy = false; return;
      }
      if (!changed) status('считаю…');
      S.bars = bars;
      S.hasVolume = bars.some(b => b.volume && b.volume > 0);
      if (bars.length < 60) { status('мало свечей (' + bars.length + ')'); S.busy = false; return; }
      S.computed = window.SignalsCore.computeAll(bars, 12);
      S.computed.__live = true; S.lastBarTime = lastT;
      saveStats(S.symbol, S.computed, bars); // сохранить exp/winrate по этому тикеру
      renderRows();
      // перерисовать активные слои
      Object.keys(S.on).forEach(id => { if (S.on[id]) drawMethod(id); });
      if (changed) { S.oi = null; S._oiSeeded = null; oiLoad(); } else if (S.oi) oiRender(); // OI: перезагрузка при смене тикера, иначе обновляем регион
      status('тикер ' + (S.symbol || '?') + ' · ' + bars.length + ' баров · обновлено ' + fmtAgo(S.statsTs));
    } catch (e) { status('ошибка: ' + (e && e.message || e)); }
    S.busy = false;
  }

  // ── рисование сигналов ───────────────────────────────────────────────────────
  function clearMethod(id) {
    (S.drawn[id] || []).forEach(sid => { try { S.chart.removeEntity(sid); } catch (e) {} });
    S.drawn[id] = [];
  }
  function clearAll() { Object.keys(S.drawn).forEach(clearMethod); }
  const MAX_MARKS = 14; // не засорять график — только начала серий, последние N
  function drawMethod(id) {
    if (!S.chart || !S.computed || !S.computed[id]) return;
    clearMethod(id);
    let vr = null; try { vr = S.chart.getVisibleRange(); } catch (e) {}
    const series = S.computed[id].series, bars = S.bars;
    if (!series || !bars.length) return; // сид из кэша (series=null) — рисовать нечего до пересчёта
    // Берём только ПЕРЕХОДЫ (начало нового сигнала / смена направления), а не
    // каждый бар — иначе частые методы (FVG, Z-score) заливают весь график.
    const marks = [];
    for (let i = 1; i < bars.length; i++) {
      const sc = series[i]; if (sc == null || sc === 0) continue;
      const pr = series[i - 1];
      const isNew = pr == null || pr === 0 || Math.sign(pr) !== Math.sign(sc);
      if (!isNew) continue;
      const b = bars[i]; if (vr && (b.time < vr.from || b.time > vr.to)) continue;
      marks.push({ b, buy: sc > 0 });
    }
    const out = [];
    marks.slice(-MAX_MARKS).forEach(m => {
      try {
        const sid = S.chart.createShape(
          { time: m.b.time, price: m.buy ? m.b.low : m.b.high },
          { shape: m.buy ? 'arrow_up' : 'arrow_down', lock: true, disableSelection: true, disableSave: true,
            zOrder: 'top', overrides: { arrowColor: S.colors[id], color: S.colors[id] } });
        if (sid) out.push(sid);
      } catch (e) {}
    });
    S.drawn[id] = out;
  }
  function toggle(id) {
    S.on[id] = !S.on[id]; savePref();
    if (S.on[id]) drawMethod(id); else clearMethod(id);
    renderRows();
  }

  // Рисование НАТИВНЫМИ инструментами TradingView — фигуры привязаны к цене/времени
  // и масштабируются/двигаются вместе с графиком. selectLineTool переводит график
  // в режим рисования, дальше пользователь рисует мышью, TV сам считает координаты.
  function drawTool(t) {
    if (!S.chart) { status('график не готов'); return; }
    if (t === '__clear') {
      if (confirm('Стереть ВСЮ разметку на графике (включая стрелки-сигналы расширения)?')) {
        try { S.chart.removeAllShapes(); } catch (e) {}
        S.drawn = {};
      }
      return;
    }
    try {
      if (typeof S.chart.selectLineTool === 'function') S.chart.selectLineTool(t);
      else status('в этой сборке рисование через API недоступно');
    } catch (e) { status('рисование: ' + (e && e.message || e)); }
  }

  // ── панель ───────────────────────────────────────────────────────────────────
  let panel, rowsEl, statusEl;
  function build() {
    panel = document.createElement('div'); panel.id = 'tvsig-panel';
    panel.innerHTML =
      '<div id="tvsig-head"><span id="tvsig-title">◆ Сигнальные модели</span>' +
      '<button id="tvsig-refresh" title="Пересчитать">⟳</button>' +
      '<button id="tvsig-min" title="Свернуть">–</button></div>' +
      '<div id="tvsig-draw">' +
      '<button class="tvsig-dt" data-t="cursor" title="Курсор — выйти из режима рисования">➤</button>' +
      '<button class="tvsig-dt" data-t="horizontal_line" title="Горизонтальный уровень">━</button>' +
      '<button class="tvsig-dt" data-t="horizontal_ray" title="Луч-уровень (от точки вправо)">┅</button>' +
      '<button class="tvsig-dt" data-t="trend_line" title="Трендлиния">╱</button>' +
      '<button class="tvsig-dt" data-t="ray" title="Луч">→</button>' +
      '<button class="tvsig-dt" data-t="parallel_channel" title="Канал (параллели)">▱</button>' +
      '<button class="tvsig-dt" data-t="rectangle" title="Прямоугольник (зона)">▭</button>' +
      '<button class="tvsig-dt" data-t="brush" title="Свободное рисование">✎</button>' +
      '<button class="tvsig-dt danger" data-t="__clear" title="Стереть ВСЮ разметку на графике">🗑</button>' +
      '</div>' +
      '<div id="tvsig-status">инициализация…</div>' +
      '<div id="tvsig-rows"></div>' +
      '<div id="tvsig-oi"><div id="tvsig-oi-head">📊 Открытый интерес' +
      '<input id="tvsig-oi-tk" placeholder="код (авто)" title="Код OI-контракта; пусто = авто по тикеру">' +
      '<button id="tvsig-oi-key" title="Токен AlgoPack для живых 5-мин данных">🔑</button>' +
      '<button id="tvsig-oi-load" title="Загрузить/обновить OI">⟳</button></div>' +
      '<div id="tvsig-oi-body"><span class="tvsig-oi-meta">физ/юр лонг-шорт и Δ по видимому окну · ⟳ загрузить</span></div></div>' +
      '<div id="tvsig-foot">Цифры считаются на свечах <b>текущего тикера</b>, хранятся по каждому и обновляются при закрытии нового бара. <b>exp</b> — экспектанси, средний P&amp;L сделки в ATR (тейк +1.0 / стоп −0.5 ATR, издержки 0.12); плюс = метод в прибыли. <b>%</b> — winrate, частота угадывания знака за 12 баров (у фейдов низкая при плюсовом exp — норма). <b>n</b> — число сделок. Клик по строке рисует сигналы.</div>';
    document.documentElement.appendChild(panel);
    rowsEl = panel.querySelector('#tvsig-rows'); statusEl = panel.querySelector('#tvsig-status');
    panel.querySelector('#tvsig-refresh').onclick = () => refresh(true);
    panel.querySelectorAll('.tvsig-dt').forEach(btn => btn.onclick = () => drawTool(btn.dataset.t));
    panel.querySelector('#tvsig-oi-load').onclick = () => oiLoad();
    panel.querySelector('#tvsig-oi-tk').addEventListener('keydown', e => { if (e.key === 'Enter') { S._oiSeeded = null; oiLoad(); } });
    const keyBtn = panel.querySelector('#tvsig-oi-key');
    function updateKeyBtn() { keyBtn.style.opacity = oiTokenGet() ? '1' : '0.5'; keyBtn.title = oiTokenGet() ? 'Токен AlgoPack задан (клик — сменить/очистить)' : 'Задать токен AlgoPack для живых 5-мин данных'; }
    keyBtn.onclick = () => {
      const has = !!oiTokenGet();
      const v = prompt('Токен AlgoPack (MOEX) для живых 5-мин физ/юр.\nХранится ЛОКАЛЬНО, шлётся только в apim.moex.com.\n' + (has ? 'Есть заданный. Введи новый, или "-" чтобы очистить.' : 'Вставь токен:'), '');
      if (v === null) return;
      if (v.trim() === '-') oiTokenSet(''); else if (v.trim()) oiTokenSet(v.trim());
      updateKeyBtn(); S._oiSeeded = null; oiLoad();
    };
    updateKeyBtn();
    let minimized = false;
    panel.querySelector('#tvsig-min').onclick = () => { minimized = !minimized; rowsEl.style.display = minimized ? 'none' : ''; panel.querySelector('#tvsig-foot').style.display = minimized ? 'none' : ''; };
    drag(panel, panel.querySelector('#tvsig-head'));
  }
  function status(t) { if (statusEl) statusEl.textContent = t; }
  function pill(sc) {
    if (sc > 0) return '<span class="tvsig-b buy">▲ buy</span>';
    if (sc < 0) return '<span class="tvsig-b sell">▼ sell</span>';
    return '<span class="tvsig-b neu">—</span>';
  }
  function renderRows() {
    if (!rowsEl) return;
    const noVol = S.hasVolume === false;
    rowsEl.innerHTML = META.map(([id]) => {
      const c = S.computed && S.computed[id];
      const on = !!S.on[id];
      const col = S.colors[id];
      // ромб-переключатель в стиле indlab: горит цветом метода когда включён
      const diam = '<span class="tvsig-diam' + (on ? ' on' : '') + '" data-id="' + id + '" title="Показать/скрыть на графике" ' +
        'style="border-color:' + col + ';background:' + (on ? col : 'transparent') + ';box-shadow:' + (on ? '0 0 6px ' + col : 'none') + ';"></span>';
      const swatch = '<input type="color" class="tvsig-col" data-id="' + id + '" value="' + col + '" title="Цвет метода">';
      const noVolRow = (id === 'vsa_abs' && noVol);
      const mid = noVolRow
        ? '<span class="tvsig-b neu" style="color:#b0873b" title="Включи индикатор Объём на графике">нужен объём</span>'
        : (function () {
            const st = c && c.stats;
            // exp — главная цифра (деньги), красим по знаку; winrate — справочная, приглушённая
            const exp = st && st.exp != null ? (st.exp >= 0 ? '+' : '') + st.exp.toFixed(2) : '—';
            const expCol = st && st.exp != null ? (st.exp > 0.03 ? '#52D8A0' : st.exp < -0.03 ? '#FF6B6B' : '#9a94b8') : '#6b6690';
            const win = st && st.acc != null ? (st.acc * 100).toFixed(0) + '%' : '—';
            const nn = st ? st.n : 0;
            return pill(c ? c.last : 0) +
              '<span class="tvsig-exp" style="color:' + expCol + '" title="exp — экспектанси: средний P&L сделки в ATR (тейк +1.0 / стоп −0.5 ATR, издержки 0.12). Плюс = метод в прибыли, даже если winrate низкий.">' + exp + '</span>' +
              '<span class="tvsig-acc" title="winrate — частота совпадения знака с ходом за 12 баров. У фейдов бывает низкой при плюсовом exp — это норма.">' + win + '</span>' +
              '<span class="tvsig-n" title="Число сделок в exp-симуляции">n' + nn + '</span>';
          })();
      return '<div class="tvsig-row' + (on ? ' on' : '') + '" data-id="' + id + '">' +
        diam + '<span class="tvsig-name">' + NAME[id] + '</span>' + mid + swatch + '</div>';
    }).join('');
    // ромб/имя → вкл/выкл; пикер цвета → своё событие (не триггерит toggle)
    rowsEl.querySelectorAll('.tvsig-diam, .tvsig-name').forEach(el =>
      el.addEventListener('click', e => { toggle(el.dataset.id || el.parentElement.dataset.id); e.stopPropagation(); }));
    rowsEl.querySelectorAll('.tvsig-col').forEach(inp => {
      inp.addEventListener('input', e => { setColor(inp.dataset.id, e.target.value); e.stopPropagation(); });
      inp.addEventListener('click', e => e.stopPropagation());
    });
  }
  function drag(el, h) {
    let sx, sy, ox, oy, on = false; h.style.cursor = 'move';
    h.addEventListener('mousedown', e => { on = true; sx = e.clientX; sy = e.clientY; const r = el.getBoundingClientRect(); ox = r.left; oy = r.top; e.preventDefault(); });
    document.addEventListener('mousemove', e => { if (!on) return; el.style.left = (ox + e.clientX - sx) + 'px'; el.style.top = (oy + e.clientY - sy) + 'px'; el.style.right = 'auto'; });
    document.addEventListener('mouseup', () => on = false);
  }

  // ── старт: ждём готовность графика ───────────────────────────────────────────
  function boot() {
    build();
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (ready()) { clearInterval(iv); status('график найден'); refresh(true);
        setInterval(() => { if (!S.busy) refresh(false); }, 2500); // отслеживаем смену тикера/данных
        setInterval(() => { if (oiTokenGet() && S.oi) oiLoad(); }, 300000); } // живой OI раз в 5 мин
      else if (tries > 120) { clearInterval(iv); status('график не найден (открой вкладку с графиком)'); }
    }, 500);
  }

  window.__tvSignals = { S, refresh, drawMethod, toggle, getApi, ready };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot); else boot();
})();
