// Режим «окна»: три панели конструктора (куски / код / отображение) превращаются в перетаскиваемые
// и масштабируемые окна (через win.js), лежащие на дефолтных местах. Переключатель «🪟 окна» в меню «⋯».
// По умолчанию выключено — обычная сеточная раскладка не трогается, пока не включишь.
(function(){
  var gwrap = document.querySelector('.gwrap');
  if(!gwrap || !window.codelabWindow){ return; }

  var st = document.createElement('style'); st.textContent = ''
    + '.cw-frame{display:flex;flex-direction:column;background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden}'
    + '.cw-title{display:flex;align-items:center;gap:6px;padding:5px 10px;border-bottom:1px solid var(--border);font-size:12px;color:var(--text2);flex:0 0 auto}'
    + '.cw-title b{font-weight:600}.cw-title .cw-sp{flex:1}'
    + '.cw-title .cw-rs{background:none;border:0;color:var(--text3);cursor:pointer;font-size:14px;padding:0 4px;border-radius:5px}'
    + '.cw-title .cw-rs:hover{color:var(--acc,#52F2C9)}'
    + '.cw-body{flex:1;min-height:0;border:0!important;border-radius:0!important;background:transparent!important}'
    + '.center.cw-body{overflow:auto}' /* окно «Код»: не обрезать песочницу, а прокручивать — иначе кнопки прячутся за край */
    + '#inspector.cw-body{overflow-y:auto;overflow-x:hidden}'  
    + '.cwin-on{display:block!important;padding:0!important;height:auto!important}'
    + '.cwin-on .gutter{display:none}';
  document.head.appendChild(st);

  var defs = [
    { sel: '.palette',   key: 'cwin_pal',  name: '📦 Куски' },
    { sel: '.center',    key: 'cwin_code', name: '🖊 Код' },
    { sel: '#inspector', key: 'cwin_insp', name: '🔎 Отображение' }
  ];
  function vp(){ var pad = 10, h = innerHeight - 2 * pad, palW = 250, inspW = 330;
    return { pad: pad, h: h, palW: palW, inspW: inspW, codeX: pad + palW + pad, codeW: Math.max(360, innerWidth - palW - inspW - 4 * pad), inspX: innerWidth - inspW - pad }; }
  function geoFor(sel, v){
    if(sel === '.palette') return { x: v.pad, y: v.pad, w: v.palW, h: v.h };
    if(sel === '#inspector') return { x: v.inspX, y: v.pad, w: v.inspW, h: v.h };
    return { x: v.codeX, y: v.pad, w: v.codeW, h: v.h };
  }

  var frames = [];
  function enable(){
    if(frames.length) return; var v = vp();
    defs.forEach(function(d){
      var panel = document.querySelector(d.sel); if(!panel) return;
      var frame = document.createElement('div'); frame.className = 'cw-frame';
      var bar = document.createElement('div'); bar.className = 'cw-title';
      bar.innerHTML = '<b></b><span class="cw-sp"></span><button class="cw-rs" title="вернуть на место">⟲</button>';
      bar.querySelector('b').textContent = d.name;
      panel.parentNode.insertBefore(frame, panel);
      frame.appendChild(bar); frame.appendChild(panel); panel.classList.add('cw-body');
      var win = window.codelabWindow.make(frame, { handle: bar, key: d.key, defaultGeo: geoFor(d.sel, v), minW: 200, minH: 150 });
      bar.querySelector('.cw-rs').onclick = function(){ win.reset(); };
      frames.push({ frame: frame, panel: panel });
    });
    gwrap.classList.add('cwin-on');
    setTimeout(function(){ window.dispatchEvent(new Event('resize')); }, 30);   // пнуть CodeMirror/обсерверы
  }
  function disable(){
    frames.forEach(function(o){ o.panel.classList.remove('cw-body'); o.panel.removeAttribute('style'); o.frame.parentNode.insertBefore(o.panel, o.frame); o.frame.remove(); });
    frames = []; gwrap.classList.remove('cwin-on');
    setTimeout(function(){ window.dispatchEvent(new Event('resize')); }, 30);
  }

  var on = false; try { on = localStorage.getItem('cwin_mode') === 'on'; } catch(e){}
  function setOn(v){ on = v; try { localStorage.setItem('cwin_mode', v ? 'on' : 'off'); } catch(e){}
    if(v) enable(); else disable();
    var btn = document.getElementById('winmode'); if(btn) btn.style.color = v ? 'var(--acc,#52F2C9)' : ''; }

  var b = document.getElementById('winmode'); if(b) b.onclick = function(){ setOn(!on); };
  if(on) setOn(true);
})();
