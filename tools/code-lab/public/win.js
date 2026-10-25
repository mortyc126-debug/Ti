// Единый «оконный» каркас: любую панель делает перетаскиваемым окном с ресайзом, границами экрана,
// макс-высотой и запоминанием позиции/размера. window.codelabWindow.make(el, {handle, key, defaultGeo, minW, minH}).
// Панель должна быть flex-колонкой с прокручиваемым телом (чтобы контент скроллился, а окно не ехало).
(function(){
  var st = document.createElement('style');
  st.textContent = ''
    + '.cw-win{position:fixed;max-width:96vw;max-height:92vh;box-sizing:border-box}'
    + '.cw-win>.cw-rz{position:absolute;right:2px;bottom:2px;width:16px;height:16px;cursor:nwse-resize;z-index:5;'
    + 'background:linear-gradient(135deg,transparent 48%,var(--border,#3a2f55) 48% 60%,transparent 60%,transparent 72%,var(--border,#3a2f55) 72% 84%,transparent 84%)}'
    + '.cw-drag{cursor:move;user-select:none;touch-action:none}';
  document.head.appendChild(st);

  function num(v){ v = parseInt(v, 10); return isNaN(v) ? 0 : v; }

  function make(el, opts){
    opts = opts || {};
    el.classList.add('cw-win');
    var key = opts.key, d = opts.defaultGeo || {}, minW = opts.minW || 240, minH = opts.minH || 160;

    function save(){ if(!key) return; try { localStorage.setItem(key, JSON.stringify({ x: num(el.style.left), y: num(el.style.top), w: num(el.style.width), h: num(el.style.height) })); } catch(e){} }
    function loadGeo(){ try { return key && JSON.parse(localStorage.getItem(key)); } catch(e){ return null; } }
    function clamp(){ var w = el.offsetWidth, h = el.offsetHeight, x = num(el.style.left), y = num(el.style.top);
      x = Math.max(60 - w, Math.min(x, innerWidth - 50)); y = Math.max(0, Math.min(y, innerHeight - 40));
      el.style.left = x + 'px'; el.style.top = y + 'px'; }
    function applyGeo(g){ g = g || {};
      var w = g.w || d.w || 360, h = g.h || d.h || 420;
      el.style.width = w + 'px'; el.style.height = h + 'px';
      el.style.left = (g.x != null ? g.x : (d.x != null ? d.x : innerWidth - w - 24)) + 'px';
      el.style.top  = (g.y != null ? g.y : (d.y != null ? d.y : innerHeight - h - 24)) + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto'; clamp(); }
    applyGeo(loadGeo());

    // перетаскивание за шапку
    var handle = opts.handle || el; handle.classList.add('cw-drag');
    handle.addEventListener('pointerdown', function(e){
      if(e.target.closest && e.target.closest('button,input,textarea,select,a,.cw-rz')) return;
      e.preventDefault(); try { handle.setPointerCapture(e.pointerId); } catch(_){}
      var sx = e.clientX, sy = e.clientY, ox = num(el.style.left), oy = num(el.style.top);
      function mv(ev){ el.style.left = (ox + ev.clientX - sx) + 'px'; el.style.top = (oy + ev.clientY - sy) + 'px'; }
      function up(){ handle.removeEventListener('pointermove', mv); handle.removeEventListener('pointerup', up); clamp(); save(); }
      handle.addEventListener('pointermove', mv); handle.addEventListener('pointerup', up);
    });

    // ресайз за уголок
    var rz = document.createElement('div'); rz.className = 'cw-rz'; el.appendChild(rz);
    rz.addEventListener('pointerdown', function(e){
      e.preventDefault(); e.stopPropagation(); try { rz.setPointerCapture(e.pointerId); } catch(_){}
      var sx = e.clientX, sy = e.clientY, ow = el.offsetWidth, oh = el.offsetHeight;
      function mv(ev){ el.style.width = Math.max(minW, ow + ev.clientX - sx) + 'px'; el.style.height = Math.max(minH, oh + ev.clientY - sy) + 'px'; }
      function up(){ rz.removeEventListener('pointermove', mv); rz.removeEventListener('pointerup', up); save(); }
      rz.addEventListener('pointermove', mv); rz.addEventListener('pointerup', up);
    });

    window.addEventListener('resize', clamp);
    return { save: save, clamp: clamp, applyGeo: applyGeo, reset: function(){ try { key && localStorage.removeItem(key); } catch(_){} applyGeo(null); } };
  }

  window.codelabWindow = { make: make };
})();
