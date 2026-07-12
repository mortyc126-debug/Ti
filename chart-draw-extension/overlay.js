/* Разметка графика — экранный слой рисования поверх веб-терминала.
 * v1: координаты экранные (пиксели вьюпорта). Инструменты: горизонтальный
 * уровень, трендлиния, луч, канал (параллели), карандаш; выделение/перенос/
 * правка/удаление; цвет+толщина; сохранение в localStorage по ключу страницы.
 * Привязка к цене графика — следующий этап (нужна шкала терминала).
 * Тестопригодность: window.__chartDraw даёт API для headless-проверки. */
(function () {
  'use strict';
  if (window.__chartDraw) return; // не дублировать

  const NS = 'chartdraw:';
  const uid = () => Math.random().toString(36).slice(2, 9);

  const state = {
    shapes: [],
    tool: 'select',      // select|hline|trend|ray|channel|free
    color: '#FF2D55',
    width: 2,
    selected: null,      // id
    drag: null,          // {mode, id, ptIdx, start:{x,y}, orig}
    draft: null,         // рисуемая сейчас фигура
    visible: true,
  };

  // ── storage (localStorage страницы — переживает перезагрузку) ──────────────
  function storeKey() {
    const sym = detectSymbol();
    return NS + location.host + location.pathname + (sym ? '#' + sym : '');
  }
  function detectSymbol() {
    // best-effort: тикер из заголовка/URL; в v1 не критично (ключ persist).
    const m = (document.title || '').match(/[A-Z]{3,6}\b/);
    if (m) return m[0];
    const p = location.pathname.match(/([A-Z]{3,6})(?:[/?#]|$)/);
    return p ? p[1] : '';
  }
  function save() {
    try { localStorage.setItem(storeKey(), JSON.stringify(state.shapes)); } catch (e) {}
  }
  let _saveT = null;
  function saveDebounced() { clearTimeout(_saveT); _saveT = setTimeout(save, 250); }
  function load() {
    try { const raw = localStorage.getItem(storeKey()); state.shapes = raw ? JSON.parse(raw) : []; }
    catch (e) { state.shapes = []; }
  }

  // ── canvas ────────────────────────────────────────────────────────────────
  const cv = document.createElement('canvas');
  cv.id = 'chartdraw-canvas';
  Object.assign(cv.style, {
    position: 'fixed', left: '0', top: '0', zIndex: '2147483000',
    pointerEvents: 'none', // включаем только когда слой активен
  });
  const ctx = cv.getContext('2d');
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  // ── геометрия / хит-тест ────────────────────────────────────────────────────
  function distToSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    let t = L2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  function hitHandle(p, s) {
    for (let i = 0; i < s.pts.length; i++)
      if (Math.hypot(p.x - s.pts[i].x, p.y - s.pts[i].y) <= 8) return i;
    return -1;
  }
  function hitShape(p, s) {
    if (s.type === 'hline') return Math.abs(p.y - s.pts[0].y) <= 6;
    if (s.type === 'free') { for (let i = 1; i < s.pts.length; i++) if (distToSeg(p, s.pts[i - 1], s.pts[i]) <= 6) return true; return false; }
    if (s.type === 'ray') { const [a, b] = s.pts; return distToSeg(p, a, { x: a.x + (b.x - a.x) * 1e4, y: a.y + (b.y - a.y) * 1e4 }) <= 6; }
    if (s.type === 'channel') { const off = s.off || { x: 0, y: 40 }; const [a, b] = s.pts;
      return distToSeg(p, a, b) <= 6 || distToSeg(p, { x: a.x + off.x, y: a.y + off.y }, { x: b.x + off.x, y: b.y + off.y }) <= 6; }
    return distToSeg(p, s.pts[0], s.pts[1]) <= 6; // trend
  }
  function pick(p) {
    for (let i = state.shapes.length - 1; i >= 0; i--) if (hitShape(p, state.shapes[i])) return state.shapes[i];
    return null;
  }

  // ── отрисовка ───────────────────────────────────────────────────────────────
  function drawShape(s, sel) {
    ctx.lineWidth = s.width || 2; ctx.strokeStyle = s.color || '#FF2D55';
    ctx.setLineDash(s.type === 'hline' ? [] : []);
    const a = s.pts[0], b = s.pts[1];
    ctx.beginPath();
    if (s.type === 'hline') {
      ctx.moveTo(0, a.y); ctx.lineTo(innerWidth, a.y); ctx.stroke();
      // ярлык уровня — чтобы было чётко видно
      const txt = s.label || ('уровень');
      ctx.font = '11px ui-monospace,monospace';
      const w = ctx.measureText(txt).width + 12;
      ctx.fillStyle = s.color; ctx.fillRect(4, a.y - 9, w, 18);
      ctx.fillStyle = '#fff'; ctx.fillText(txt, 10, a.y + 4);
    } else if (s.type === 'free') {
      ctx.moveTo(s.pts[0].x, s.pts[0].y);
      for (let i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i].x, s.pts[i].y);
      ctx.stroke();
    } else if (s.type === 'ray') {
      const dx = b.x - a.x, dy = b.y - a.y;
      ctx.moveTo(a.x, a.y); ctx.lineTo(a.x + dx * 1e4, a.y + dy * 1e4); ctx.stroke();
    } else if (s.type === 'channel') {
      const off = s.off || { x: 0, y: 40 };
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(a.x + off.x, a.y + off.y); ctx.lineTo(b.x + off.x, b.y + off.y); ctx.stroke();
      ctx.globalAlpha = 0.08; ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.lineTo(b.x + off.x, b.y + off.y); ctx.lineTo(a.x + off.x, a.y + off.y); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
    } else { // trend
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    if (sel) {
      ctx.fillStyle = '#fff'; ctx.strokeStyle = s.color; ctx.lineWidth = 1.5;
      const handles = s.type === 'hline' ? [{ x: innerWidth / 2, y: a.y }] : s.pts.slice();
      if (s.type === 'channel') { const off = s.off || { x: 0, y: 40 }; handles.push({ x: (a.x + b.x) / 2 + off.x, y: (a.y + b.y) / 2 + off.y }); }
      handles.forEach(h => { ctx.beginPath(); ctx.arc(h.x, h.y, 5, 0, 7); ctx.fill(); ctx.stroke(); });
    }
  }
  function redraw() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (!state.visible) return;
    state.shapes.forEach(s => drawShape(s, s.id === state.selected));
    if (state.draft) drawShape(state.draft, false);
  }

  // ── ввод ────────────────────────────────────────────────────────────────────
  function evtPt(e) { return { x: e.clientX, y: e.clientY }; }
  function onDown(e) {
    if (!state.visible) return;
    const p = evtPt(e);
    if (state.tool === 'select') {
      const s = state.shapes.find(x => x.id === state.selected);
      if (s) { const hi = hitHandle(p, s.type === 'channel' ? { pts: s.pts.concat([{ x: (s.pts[0].x + s.pts[1].x) / 2 + (s.off || {}).x || 0, y: (s.pts[0].y + s.pts[1].y) / 2 + ((s.off || {}).y || 40) }]) } : s);
        if (hi >= 0) { state.drag = { mode: 'handle', id: s.id, ptIdx: hi, start: p, orig: JSON.parse(JSON.stringify(s)) }; e.preventDefault(); return; } }
      const hit = pick(p);
      state.selected = hit ? hit.id : null;
      if (hit) state.drag = { mode: 'move', id: hit.id, start: p, orig: JSON.parse(JSON.stringify(hit)) };
      redraw(); e.preventDefault(); return;
    }
    // рисование
    if (state.tool === 'hline') {
      addShape({ type: 'hline', pts: [{ x: 0, y: p.y }] });
      e.preventDefault(); return;
    }
    state.draft = { id: uid(), type: state.tool, color: state.color, width: state.width,
      pts: state.tool === 'free' ? [p] : [p, { x: p.x, y: p.y }] };
    if (state.tool === 'channel') state.draft.off = { x: 0, y: 40 };
    e.preventDefault();
  }
  function onMove(e) {
    if (!state.visible) return;
    const p = evtPt(e);
    if (state.drag) {
      const s = state.shapes.find(x => x.id === state.drag.id); if (!s) return;
      const o = state.drag.orig, dx = p.x - state.drag.start.x, dy = p.y - state.drag.start.y;
      if (state.drag.mode === 'move') {
        s.pts = o.pts.map(pt => ({ x: pt.x + dx, y: pt.y + dy }));
      } else { // handle
        const i = state.drag.ptIdx;
        if (s.type === 'channel' && i === 2) { s.off = { x: (o.off ? o.off.x : 0) + dx, y: (o.off ? o.off.y : 40) + dy }; }
        else if (s.type === 'hline') { s.pts[0] = { x: 0, y: o.pts[0].y + dy }; }
        else { s.pts[i] = { x: o.pts[i].x + dx, y: o.pts[i].y + dy }; }
      }
      redraw(); return;
    }
    if (state.draft) {
      if (state.draft.type === 'free') state.draft.pts.push(p);
      else state.draft.pts[1] = p;
      redraw();
    }
  }
  function onUp() {
    if (state.drag) { state.drag = null; saveDebounced(); return; }
    if (state.draft) {
      const d = state.draft; state.draft = null;
      // отбрасываем «тычки» (нулевой размер) кроме карандаша
      if (d.type !== 'free' && Math.hypot(d.pts[1].x - d.pts[0].x, d.pts[1].y - d.pts[0].y) < 3) { redraw(); return; }
      state.shapes.push(d); state.selected = d.id; saveDebounced(); redraw();
    }
  }
  function onKey(e) {
    if (e.altKey && (e.key === 'd' || e.key === 'D' || e.key === 'в' || e.key === 'В')) { toggle(); e.preventDefault(); return; }
    if (!state.visible) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) {
      state.shapes = state.shapes.filter(s => s.id !== state.selected); state.selected = null; saveDebounced(); redraw(); e.preventDefault();
    }
    if (e.key === 'Escape') { state.draft = null; state.selected = null; setTool('select'); redraw(); }
  }

  function addShape(partial) {
    const s = Object.assign({ id: uid(), color: state.color, width: state.width }, partial);
    state.shapes.push(s); state.selected = s.id; saveDebounced(); redraw(); return s;
  }

  // ── панель инструментов ─────────────────────────────────────────────────────
  let bar;
  function buildBar() {
    bar = document.createElement('div'); bar.id = 'chartdraw-bar';
    const tools = [['select', '⭶ выбрать'], ['hline', '━ уровень'], ['trend', '╱ линия'],
      ['ray', '⟶ луч'], ['channel', '▱ канал'], ['free', '✎ каранд.']];
    bar.innerHTML =
      '<div class="cd-title" title="Тащи за заголовок">✎ Разметка</div>' +
      tools.map(t => `<button data-tool="${t[0]}" class="cd-tool">${t[1]}</button>`).join('') +
      '<input type="color" id="cd-color" value="' + state.color + '" title="Цвет">' +
      '<input type="range" id="cd-width" min="1" max="8" value="' + state.width + '" title="Толщина">' +
      '<button id="cd-clear" class="cd-x" title="Удалить всё на этой странице">✕ очистить</button>' +
      '<button id="cd-hide" class="cd-x" title="Скрыть слой (Alt+D)">спрятать</button>';
    document.documentElement.appendChild(bar);
    bar.querySelectorAll('.cd-tool').forEach(b => b.onclick = () => setTool(b.dataset.tool));
    bar.querySelector('#cd-color').oninput = e => { state.color = e.target.value; const s = state.shapes.find(x => x.id === state.selected); if (s) { s.color = state.color; saveDebounced(); redraw(); } };
    bar.querySelector('#cd-width').oninput = e => { state.width = +e.target.value; const s = state.shapes.find(x => x.id === state.selected); if (s) { s.width = state.width; saveDebounced(); redraw(); } };
    bar.querySelector('#cd-clear').onclick = () => { if (confirm('Удалить всю разметку на этой странице?')) { state.shapes = []; state.selected = null; save(); redraw(); } };
    bar.querySelector('#cd-hide').onclick = () => toggle();
    makeDraggable(bar, bar.querySelector('.cd-title'));
    reflectTool();
  }
  function reflectTool() { if (!bar) return; bar.querySelectorAll('.cd-tool').forEach(b => b.classList.toggle('on', b.dataset.tool === state.tool)); }
  function setTool(t) { state.tool = t; cv.style.pointerEvents = state.visible ? 'auto' : 'none'; reflectTool(); }
  function makeDraggable(el, handle) {
    let sx, sy, ox, oy, on = false;
    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', e => { on = true; sx = e.clientX; sy = e.clientY; const r = el.getBoundingClientRect(); ox = r.left; oy = r.top; e.preventDefault(); });
    document.addEventListener('mousemove', e => { if (!on) return; el.style.left = (ox + e.clientX - sx) + 'px'; el.style.top = (oy + e.clientY - sy) + 'px'; el.style.right = 'auto'; });
    document.addEventListener('mouseup', () => on = false);
  }
  function toggle() {
    state.visible = !state.visible;
    cv.style.display = state.visible ? 'block' : 'none';
    cv.style.pointerEvents = state.visible ? 'auto' : 'none';
    if (bar) bar.style.opacity = state.visible ? '1' : '0.35';
    redraw();
  }

  // ── init ────────────────────────────────────────────────────────────────────
  function init() {
    document.documentElement.appendChild(cv);
    buildBar();
    load(); resize();
    cv.style.pointerEvents = 'auto';
    addEventListener('resize', resize);
    cv.addEventListener('mousedown', onDown);
    addEventListener('mousemove', onMove);
    addEventListener('mouseup', onUp);
    addEventListener('keydown', onKey, true);
  }

  // API для тестов/интеграции
  window.__chartDraw = {
    state, setTool, addShape, save, load, redraw, toggle,
    getShapes: () => state.shapes, clear: () => { state.shapes = []; save(); redraw(); },
    _pick: pick, _hitShape: hitShape, storeKey,
  };

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', init); else init();
})();
