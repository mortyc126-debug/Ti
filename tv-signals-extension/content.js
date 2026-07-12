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
  const PREF = 'tvsig:on', CKEY = 'tvsig:colors';

  const S = {
    api: null, chart: null, bars: [], symbol: '', res: null,
    on: loadPref(), colors: loadColors(), drawn: {}, // id -> [shapeId]
    computed: null, busy: false, hasVolume: null, oi: null,
  };
  const OI_BASE_DEF = 'https://oi.marginacall.workers.dev';
  function oiBase() { try { return localStorage.getItem('tvsig:oibase') || OI_BASE_DEF; } catch (e) { return OI_BASE_DEF; } }
  // мост в isolated-world (oi-bridge.js) — обход CSP терминала на фетч воркера
  function oiFetch(url) {
    return new Promise(resolve => {
      const id = 'oi' + Math.random().toString(36).slice(2);
      function onRes(e) { let r; try { r = JSON.parse(e.detail); } catch (_) { return; } if (r.id !== id) return; window.removeEventListener('tvsig:oi:res', onRes); resolve(r); }
      window.addEventListener('tvsig:oi:res', onRes);
      window.dispatchEvent(new CustomEvent('tvsig:oi:req', { detail: JSON.stringify({ id, url }) }));
      setTimeout(() => { window.removeEventListener('tvsig:oi:res', onRes); resolve({ ok: false, error: 'timeout' }); }, 9000);
    });
  }
  function oiNormalize(r) {
    return { date: r.tradedate || r.date || r.timestamp || '',
      ts: (Date.parse(String(r.tradedate || r.date || '').replace(' ', 'T')) / 1000) || 0,
      fl: +(r.fiz_long || 0), fs: +(r.fiz_short || 0), yl: +(r.yur_long || 0), ys: +(r.yur_short || 0) };
  }
  async function oiLoad() {
    if (!S.chart) return;
    const body = document.getElementById('tvsig-oi-body'); if (body) body.textContent = 'загрузка…';
    let sym = ''; try { sym = S.chart.symbol(); } catch (e) {}
    const ov = ((document.getElementById('tvsig-oi-tk') || {}).value || '').trim().toUpperCase();
    const cands = [];
    if (ov) cands.push(ov);
    if (sym) { const u = sym.toUpperCase(); cands.push(u); const m = u.match(/^([A-Z]{2})/); if (m && cands.indexOf(m[1]) < 0) cands.push(m[1]); }
    let rows = null, used = '';
    for (const c of cands) {
      const r = await oiFetch(oiBase() + '/db/oidaily?ticker=' + encodeURIComponent(c));
      if (r.ok) { let arr; try { const j = JSON.parse(r.json); arr = Array.isArray(j) ? j : (j.rows || j.data || []); } catch (_) { arr = []; }
        const norm = arr.map(oiNormalize).filter(x => x.ts); if (norm.length) { rows = norm.sort((a, b) => a.ts - b.ts); used = c; break; } }
    }
    if (!rows) { if (body) body.innerHTML = '<span style="color:#b0873b">OI не найден (' + (cands.join(' / ') || '?') + '). Введи код контракта вручную и ⟳.</span>'; S.oi = null; return; }
    S.oi = { rows, used }; oiRender();
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
      '<div class="tvsig-oi-meta">' + S.oi.used + ' · регион ' + reg.length + ' дн (' + a.date + '…' + b.date + ')</div>' +
      '<table class="tvsig-oi-t"><tr><th></th><th>лонг</th><th>шорт</th></tr>' +
      '<tr><td>физ</td><td>' + cell(b.fl, b.fl - a.fl) + '</td><td>' + cell(b.fs, b.fs - a.fs) + '</td></tr>' +
      '<tr><td>юр</td><td>' + cell(b.yl, b.yl - a.yl) + '</td><td>' + cell(b.ys, b.ys - a.ys) + '</td></tr></table>';
  }
  function loadPref() { try { return JSON.parse(localStorage.getItem(PREF) || '{}'); } catch (e) { return {}; } }
  function savePref() { try { localStorage.setItem(PREF, JSON.stringify(S.on)); } catch (e) {} }
  function loadColors() { try { return Object.assign({}, DEF_COLOR, JSON.parse(localStorage.getItem(CKEY) || '{}')); } catch (e) { return Object.assign({}, DEF_COLOR); } }
  function saveColors() { try { localStorage.setItem(CKEY, JSON.stringify(S.colors)); } catch (e) {} }
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
    S.busy = true; status('считаю…');
    try {
      let sym = ''; try { sym = S.chart.symbol(); } catch (e) {}
      const changed = sym !== S.symbol; if (changed) { clearAll(); S.symbol = sym; }
      const res = await Promise.resolve(S.chart.exportData());
      let bars = window.SignalsCore.parseExport(res);
      if (bars.length > 3000) bars = bars.slice(-3000); // держим NW (O(n^2)) в узде
      S.bars = bars;
      S.hasVolume = bars.some(b => b.volume && b.volume > 0);
      if (bars.length < 60) { status('мало свечей (' + bars.length + ')'); S.busy = false; return; }
      S.computed = window.SignalsCore.computeAll(bars, 12);
      renderRows();
      // перерисовать активные слои
      Object.keys(S.on).forEach(id => { if (S.on[id]) drawMethod(id); });
      if (changed) { S.oi = null; oiLoad(); } else if (S.oi) oiRender(); // OI: перезагрузка при смене тикера, иначе обновляем регион
      status('тикер ' + (S.symbol || '?') + ' · ' + bars.length + ' баров');
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

  // ── панель ───────────────────────────────────────────────────────────────────
  let panel, rowsEl, statusEl;
  function build() {
    panel = document.createElement('div'); panel.id = 'tvsig-panel';
    panel.innerHTML =
      '<div id="tvsig-head"><span id="tvsig-title">◆ Сигнальные модели</span>' +
      '<button id="tvsig-refresh" title="Пересчитать">⟳</button>' +
      '<button id="tvsig-min" title="Свернуть">–</button></div>' +
      '<div id="tvsig-status">инициализация…</div>' +
      '<div id="tvsig-rows"></div>' +
      '<div id="tvsig-oi"><div id="tvsig-oi-head">📊 Открытый интерес' +
      '<input id="tvsig-oi-tk" placeholder="код (авто)" title="Код OI-контракта; пусто = авто по тикеру">' +
      '<button id="tvsig-oi-load" title="Загрузить/обновить OI">⟳</button></div>' +
      '<div id="tvsig-oi-body"><span class="tvsig-oi-meta">физ/юр лонг-шорт и Δ по видимому окну · ⟳ загрузить</span></div></div>' +
      '<div id="tvsig-foot">точн. — доля совпадения знака с ходом за 12 баров по этому тикеру · клик по строке рисует сигналы на графике</div>';
    document.documentElement.appendChild(panel);
    rowsEl = panel.querySelector('#tvsig-rows'); statusEl = panel.querySelector('#tvsig-status');
    panel.querySelector('#tvsig-refresh').onclick = () => refresh(true);
    panel.querySelector('#tvsig-oi-load').onclick = () => oiLoad();
    panel.querySelector('#tvsig-oi-tk').addEventListener('keydown', e => { if (e.key === 'Enter') oiLoad(); });
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
            const acc = c && c.stats.acc != null ? (c.stats.acc * 100).toFixed(0) + '%' : '—';
            const nn = c ? c.stats.n : 0;
            const accCol = c && c.stats.acc != null ? (c.stats.acc >= 0.55 ? '#52D8A0' : c.stats.acc <= 0.45 ? '#FF6B6B' : '#9a94b8') : '#6b6690';
            return pill(c ? c.last : 0) + '<span class="tvsig-acc" style="color:' + accCol + '">' + acc + '</span><span class="tvsig-n">n' + nn + '</span>';
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
        setInterval(() => { if (!S.busy) refresh(false); }, 2500); } // отслеживаем смену тикера/данных
      else if (tries > 120) { clearInterval(iv); status('график не найден (открой вкладку с графиком)'); }
    }, 500);
  }

  window.__tvSignals = { S, refresh, drawMethod, toggle, getApi, ready };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot); else boot();
})();
