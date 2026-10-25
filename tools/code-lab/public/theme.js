// Темы и цвета: кольцо оттенка + квадрат, ползунки, палитра, темы. Подключается из shell.js.
(function(){
  var KEY = 'codelab_theme_v1';
  var SLOTS = [['bg','фон страницы'],['bg2','панели'],['s2','кнопки и поля'],['border','рамки'],['text','текст'],['text2','текст 2'],['text3','подписи'],['acc','акцент'],['kw','ключевые слова'],['name','имена'],['fn','функции'],['str','строки'],['num','числа']];
  var DEF = { bg:'#0E0720', bg2:'#140A24', s2:'#1A1030', border:'#241638', text:'#F6F4FF', text2:'#CBC2EA', text3:'#9C90C4', acc:'#FF006E', kw:'#B45CFF', name:'#3DD9FF', fn:'#FF2FAE', str:'#52F2C9', num:'#FF8800' };
  var SL = [['bright','яркость всего',50,150],['sat','насыщенность всего',0,200],['fbright','яркость шрифтов',40,160],['fsat','насыщенность шрифтов',0,200],['panelA','непрозрачность панелей (с картинкой)',10,100],['blur','размытие панелей, px',0,30]];
  function clone(o){ return JSON.parse(JSON.stringify(o)); }
  function mk(id, name){ return { id:id, name:name, vars:clone(DEF), bright:100, sat:100, fbright:100, fsat:100, img:false, panelA:70, blur:0, layers:[] }; }
  var st; try { st = JSON.parse(localStorage.getItem(KEY)); } catch(e){}
  if(!st || !st.themes || !st.themes.length) st = { active:'default', themes:[mk('default','Стандартная')], palette:['#FF006E','#B45CFF','#3DD9FF','#52F2C9','#FF8800'] };
  st.themes.forEach(function(t){ if(t.panelA == null) t.panelA = 70; if(t.blur == null) t.blur = 0; if(!t.layers) t.layers = []; if(t.img == null) t.img = false; });
  function save(){ try { localStorage.setItem(KEY, JSON.stringify(st)); } catch(e){} }
  function cur(){ return st.themes.filter(function(t){ return t.id === st.active; })[0] || st.themes[0]; }

  // ── цвет ──
  function p2h(n){ n = Math.max(0, Math.min(255, Math.round(n))); return (n < 16 ? '0' : '') + n.toString(16); }
  function hex2rgb(h){ h = h.replace('#',''); if(h.length < 6) h = h.replace(/./g, '$&$&'); return { r:parseInt(h.substr(0,2),16), g:parseInt(h.substr(2,2),16), b:parseInt(h.substr(4,2),16), a:h.length >= 8 ? parseInt(h.substr(6,2),16)/255 : 1 }; }
  function rgb2hex(r,g,b,a){ return ('#' + p2h(r) + p2h(g) + p2h(b) + (a < 1 ? p2h(a*255) : '')).toUpperCase(); }
  function rgb2hsv(c){ var r=c.r/255, g=c.g/255, b=c.b/255, m=Math.max(r,g,b), d=m-Math.min(r,g,b), h=0; if(d){ h = m==r ? ((g-b)/d+6)%6 : m==g ? (b-r)/d+2 : (r-g)/d+4; h *= 60; } return { h:h, s:m ? d/m : 0, v:m }; }
  function hsv2rgb(h,s,v){ var f = function(n){ var k=(n+h/60)%6; return (v - v*s*Math.max(0, Math.min(k, 4-k, 1))) * 255; }; return { r:f(5), g:f(3), b:f(1) }; }
  function adj(hex, b, s){ var c = hex2rgb(hex), v = rgb2hsv(c); v.v = Math.min(1, v.v*b); v.s = Math.min(1, v.s*s); var o = hsv2rgb(v.h, v.s, v.v); return rgb2hex(o.r, o.g, o.b, c.a); }

  // ── применение темы ──
  // все панели-поверхности, которые должны одинаково «матироваться» при фоне-картинке (иначе «то прозрачно, то нет»):
  // оболочка/каталог + песочница (редактор, попапы, поиск, структура, окно ИИ) + конструктор (инспектор, холст, узлы) + модалки.
  var BLUR_SEL = '.side,.palette,.g-insp,.canvas-scroll,.modal,.th-box,.sb-ed,.sb-pop,.sb-find,.sb-find-note,.sb-outline,.ai-ask,.gnode,.sb-pop-b,.modal-bg .modal,.sb-bar,.c-toolbar,.tb-pop,.ac-pop,.sim-panel,.note-pop,.nav-pop,.btn,.lp-prev,.inv-card,.tpl,header,nav';
  var sty = document.createElement('style'); sty.id = 'th-style'; document.head.appendChild(sty);
  var IC = {};
  function bgImg(id){ if(!(id in IC)){ try { IC[id] = localStorage.getItem(KEY + '_img_' + id) || ''; } catch(e){ IC[id] = ''; } } return IC[id]; }
  function mulA(hex, k){ var c = hex2rgb(hex); return rgb2hex(c.r, c.g, c.b, c.a * k); }
  function loadImg(file, cb){
    var fr = new FileReader();
    fr.onload = function(){ var im = new Image(); im.onload = function(){
      var k = Math.min(1, 1600 / Math.max(im.width, im.height)), c = document.createElement('canvas');
      c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); cb(c.toDataURL('image/jpeg', .82));
    }; im.src = fr.result; };
    fr.readAsDataURL(file);
  }
  function apply(){
    var t = cur(), r = document.documentElement.style, im = t.img ? bgImg(t.id) : '', pa = im ? t.panelA / 100 : 1;
    SLOTS.forEach(function(s){
      var k = s[0], c = t.vars[k] || DEF[k];
      if(k.indexOf('text') === 0) c = adj(c, t.fbright/100, t.fsat/100);
      if(im && (k === 'bg' || k === 'bg2' || k === 's2')) c = mulA(c, pa);
      r.setProperty('--' + k, c);
    });
    r.setProperty('--code-bg', t.vars.bg || DEF.bg);   // области кода остаются сплошными
    var L = t.layers.map(function(c){ return 'linear-gradient(' + c + ',' + c + ')'; });
    if(im) L.push('url("' + im + '") center/cover no-repeat fixed');
    L.push(t.vars.bg || DEF.bg);
    sty.textContent = 'html{background:#000;' + (t.bright == 100 && t.sat == 100 ? '' : 'filter:brightness(' + t.bright + '%) saturate(' + t.sat + '%);') + '}'
      + (L.length > 1 ? 'body{background:' + L.join(',') + '!important}' : '')
      + (im && t.blur > 0 ? BLUR_SEL + '{backdrop-filter:blur(' + t.blur + 'px)}' : '');
  }
  apply();

  // ── выбор цвета: кольцо оттенка + квадрат + линии ──
  function Picker(host, onChange){
    var R = 90, r = 70, S = 90, o = 45, p = { h:0, s:1, v:1, a:1 }, mode = null;
    host.innerHTML = '<div class="tp-w"><div class="tp-ring"></div><div class="tp-sq"></div><i class="tp-k tp-kr"></i><i class="tp-k tp-ks"></i></div>'
      + '<label class="tp-l">оттенок<input type="range" class="tp-h" min="0" max="360"></label>'
      + '<label class="tp-l">насыщенность<input type="range" class="tp-s" min="0" max="100"></label>'
      + '<label class="tp-l">прозрачность<input type="range" class="tp-a" min="0" max="100"></label>'
      + '<input class="tp-hex" spellcheck="false">';
    var q = function(s){ return host.querySelector(s); }, w = q('.tp-w'), sq = q('.tp-sq'), kr = q('.tp-kr'), ks = q('.tp-ks'), H = q('.tp-h'), Sl = q('.tp-s'), A = q('.tp-a'), X = q('.tp-hex');
    var rgb = function(c){ return 'rgb(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ')'; };
    function hex(){ var c = hsv2rgb(p.h, p.s, p.v); return rgb2hex(c.r, c.g, c.b, p.a); }
    function draw(){
      var full = hsv2rgb(p.h, 1, 1), now = hsv2rgb(p.h, p.s, p.v), a = p.h * Math.PI / 180;
      sq.style.background = 'linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,' + rgb(full) + ')';
      kr.style.left = (R + 80*Math.sin(a)) + 'px'; kr.style.top = (R - 80*Math.cos(a)) + 'px';
      ks.style.left = (o + p.s*S) + 'px'; ks.style.top = (o + (1 - p.v)*S) + 'px';
      H.value = p.h; Sl.value = Math.round(p.s*100); A.value = Math.round(p.a*100);
      Sl.style.background = 'linear-gradient(to right,' + rgb(hsv2rgb(p.h, 0, p.v)) + ',' + rgb(hsv2rgb(p.h, 1, p.v)) + ')';
      A.style.background = 'linear-gradient(to right,transparent,' + rgb(now) + '),repeating-conic-gradient(#888 0 25%,#555 0 50%) 0 0/8px 8px';
      X.value = hex();
    }
    function pos(e){ var b = w.getBoundingClientRect(); return { x:e.clientX - b.left, y:e.clientY - b.top }; }
    function upd(e){
      var m = pos(e);
      if(mode == 'h') p.h = (Math.atan2(m.x - R, R - m.y) * 180 / Math.PI + 360) % 360;
      else { p.s = Math.max(0, Math.min(1, (m.x - o)/S)); p.v = 1 - Math.max(0, Math.min(1, (m.y - o)/S)); }
      draw(); onChange(hex());
    }
    w.addEventListener('pointerdown', function(e){
      var m = pos(e), d = Math.hypot(m.x - R, m.y - R);
      mode = (d > r && d <= R) ? 'h' : (m.x >= o && m.x <= o + S && m.y >= o && m.y <= o + S ? 'sv' : null);
      if(!mode) return; w.setPointerCapture(e.pointerId); upd(e);
    });
    w.addEventListener('pointermove', function(e){ if(mode) upd(e); });
    w.addEventListener('pointerup', function(){ mode = null; });
    H.oninput = function(){ p.h = +H.value; draw(); onChange(hex()); };
    Sl.oninput = function(){ p.s = Sl.value/100; draw(); onChange(hex()); };
    A.oninput = function(){ p.a = A.value/100; draw(); onChange(hex()); };
    function set(h){ if(!/^#?[0-9a-f]{3}([0-9a-f]{3}([0-9a-f]{2})?)?$/i.test(h)) return false; var c = hex2rgb(h), v = rgb2hsv(c); p.h = v.h; p.s = v.s; p.v = v.v; p.a = c.a; draw(); return true; }
    X.onchange = function(){ if(set(X.value)) onChange(hex()); else draw(); };
    draw();
    return { set:set, hex:hex };
  }

  // ── окно «Темы и цвета» ──
  var css = document.createElement('style');
  css.textContent = '.th-bg{position:fixed;inset:0;z-index:300;background:rgba(5,2,14,.7);display:flex;align-items:center;justify-content:center;padding:16px}'
    + '.th-box{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:14px 16px;width:min(780px,100%);max-height:94vh;overflow:auto;color:var(--text);font:13px/1.4 system-ui,sans-serif}'
    + '.th-top{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}'
    + '.th-sel,.th-b{font:12px/1 ui-monospace,monospace;color:var(--text2);background:var(--s2);border:1px solid var(--border);border-radius:6px;height:30px;padding:0 10px;cursor:pointer}'
    + '.th-b:hover{color:var(--acc);border-color:var(--acc)}'
    + '.th-main{display:grid;grid-template-columns:210px 1fr;gap:18px}@media(max-width:640px){.th-main{grid-template-columns:1fr}}'
    + '.th-slot{display:flex;gap:9px;align-items:center;padding:6px 8px;border-radius:8px;cursor:pointer;color:var(--text2);border:1px solid transparent}'
    + '.th-slot:hover{background:var(--s2)}.th-slot.on{border-color:var(--acc);color:var(--text)}'
    + '.th-slot i{width:18px;height:18px;border-radius:5px;border:1px solid rgba(255,255,255,.25);flex:none}'
    + '.th-pal-h{display:flex;align-items:center;justify-content:space-between;margin:14px 0 6px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.04em}'
    + '.th-pal{display:flex;flex-wrap:wrap;gap:6px}.th-pal i{width:24px;height:24px;border-radius:7px;border:1px solid rgba(255,255,255,.25);cursor:pointer}'
    + '.th-hint{font-size:11px;color:var(--text3);margin-top:6px}.th-sl{margin-top:14px;border-top:1px solid var(--border);padding-top:6px;display:grid;grid-template-columns:1fr 1fr;gap:0 18px}'
    + '.tp-w{position:relative;width:180px;height:180px;margin:0 auto 10px;touch-action:none;cursor:crosshair}'
    + '.tp-ring{position:absolute;inset:0;border-radius:50%;background:conic-gradient(#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00);-webkit-mask:radial-gradient(circle,transparent 69px,#000 70px);mask:radial-gradient(circle,transparent 69px,#000 70px)}'
    + '.tp-sq{position:absolute;left:45px;top:45px;width:90px;height:90px;border-radius:6px}'
    + '.tp-k{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px #000,inset 0 0 0 1px #000;pointer-events:none}'
    + '.tp-l{display:block;font-size:11px;color:var(--text3);margin:7px 0 0}.tp-l b{color:var(--text2);font-weight:600}'
    + '.tp-l input{display:block;width:100%;height:10px;border-radius:6px;-webkit-appearance:none;appearance:none;outline:none;margin:5px 0 0;background:var(--s2);border:1px solid var(--border)}'
    + '.tp-l input::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#fff;border:2px solid #000;cursor:pointer}'
    + '.tp-h{background:linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)!important}'
    + '.th-x{color:var(--text3);padding:0 4px;cursor:pointer}.th-x:hover{color:#FF6B6B}.th-img{display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap}.th-slots{max-height:430px;overflow:auto}'
    + '#lab-mistral-settings .panel{background:var(--bg2,#160d23);border-color:var(--border,#49305f);color:var(--text,#f5eaff)}'
    + '#lab-mistral-settings.th-wide .panel{width:min(800px,calc(100vw - 32px));max-height:92vh;overflow:auto}'
    + '#lab-mistral-open{background:var(--s2,#21112f);border-color:var(--border,#51336e);color:var(--text,#f5eaff)}'
    + '#lab-mistral-settings .st-tabs{display:flex;gap:4px;margin:0 0 14px;border-bottom:1px solid var(--border,#49305f)}'
    + '#lab-mistral-settings .st-tabs button{background:none;border:0;border-bottom:2px solid transparent;border-radius:0;margin:0 0 -1px;padding:8px 16px;color:var(--text3,#bca9d8);font:600 14px system-ui}'
    + '#lab-mistral-settings .st-tabs button.on{color:var(--text,#fff);border-bottom-color:var(--acc,#ff006e)}'
    + '#lab-mistral-settings .th-box{background:none;border:0;padding:0;max-height:none;width:auto;overflow:visible}'
    + '#lab-mistral-settings .th-emb .th-b{height:30px;margin:0;padding:0 10px;background:var(--s2);border:1px solid var(--border);border-radius:6px;font:12px/1 ui-monospace,monospace;color:var(--text2)}'
    + '#lab-mistral-settings .th-emb .th-b:hover{color:var(--acc);border-color:var(--acc)}'
    + '#lab-mistral-settings .svc{background:var(--s2,#1a1030);border:1px solid var(--border,#49305f);border-radius:12px;padding:12px 14px;margin:10px 0 12px}'
    + '#lab-mistral-settings .svc-h{display:flex;justify-content:space-between;align-items:baseline}#lab-mistral-settings .svc-h span{color:var(--text3,#bca9d8);font-size:12px}'
    + '#lab-mistral-settings .svc #lab-mistral-key{margin:8px 0 0;background:var(--bg,#0d0716);color:var(--text,#fff);border-color:var(--border,#49305f)}'
    + '#lab-mistral-settings .svc-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}'
    + '.tp-hex{width:100%;margin-top:9px;background:var(--bg);border:1px solid var(--border);border-radius:7px;color:var(--text);font:12.5px ui-monospace,monospace;padding:7px 9px}';
  document.head.appendChild(css);

  var box, picker, sel = 'acc';
  function getc(k){ var t = cur(); return k[0] === 'L' ? (t.layers[+k.slice(1)] || '#00000066') : (t.vars[k] || DEF[k]); }
  function setc(k, h){ var t = cur(); if(k[0] === 'L') t.layers[+k.slice(1)] = h; else t.vars[k] = h; }
  function $(s){ return box.querySelector(s); }
  function fillSel(){ $('.th-sel').innerHTML = st.themes.map(function(t){ return '<option value="' + t.id + '"' + (t.id === st.active ? ' selected' : '') + '>' + t.name.replace(/</g,'&lt;') + '</option>'; }).join(''); }
  function fillSlots(){
    var t = cur(), row = function(k, label, x){ return '<div class="th-slot' + (k === sel ? ' on' : '') + '" data-k="' + k + '"><i style="background:' + getc(k) + '"></i><span style="flex:1">' + label + '</span>' + (x ? '<b class="th-x" data-l="' + x + '">✕</b>' : '') + '</div>'; };
    $('.th-slots').innerHTML = SLOTS.map(function(s){ return row(s[0], s[1]); }).join('')
      + '<div class="th-pal-h">слои поверх картинки <button class="th-b" data-a="ladd">＋ слой</button></div>'
      + t.layers.map(function(c, i){ return row('L' + i, 'слой ' + (i + 1), String(i)); }).join('');
  }
  function fillPal(){ $('.th-pal').innerHTML = st.palette.map(function(c, i){ return '<i data-i="' + i + '" style="background:' + c + '" title="' + c + '"></i>'; }).join(''); }
  function fillSl(){ var t = cur(); $('.th-sl').innerHTML = SL.map(function(s){ return '<label class="tp-l">' + s[1] + ' <b>' + t[s[0]] + (s[0] == 'blur' ? 'px' : '%') + '</b><input type="range" data-s="' + s[0] + '" min="' + s[2] + '" max="' + s[3] + '" value="' + t[s[0]] + '"></label>'; }).join(''); }
  function refresh(){ fillSel(); fillSlots(); fillPal(); fillSl(); picker.set(getc(sel)); }
  function close(){ var m = document.getElementById('lab-mistral-settings'); if(m) m.style.display = 'none'; }

  function build(host){
    box = host;
    box.innerHTML = '<div class="th-box"><div class="th-top"><b>Темы и цвета</b><select class="th-sel"></select>'
      + '<button class="th-b" data-a="new">＋ новая</button><button class="th-b" data-a="del">🗑 удалить</button><button class="th-b" data-a="reset">↺ сбросить</button><span style="flex:1"></span><button class="th-b" data-a="x">✕</button></div>'
      + '<div class="th-main"><div class="th-slots"></div><div><div class="th-pk"></div>'
      + '<div class="th-pal-h">сохранённые цвета <button class="th-b" data-a="padd">＋ текущий</button></div><div class="th-pal"></div>'
      + '<div class="th-hint">клик — применить к выбранному · двойной клик — заменить текущим · правый клик — удалить</div></div></div>'
      + '<div class="th-img"><button class="th-b" data-a="img">🖼 фон-картинка…</button><button class="th-b" data-a="imgx">убрать картинку</button><input type="file" class="th-file" accept="image/*" hidden></div><div class="th-sl"></div></div>';
    picker = Picker($('.th-pk'), function(hex){
      setc(sel, hex); apply(); save();
      var sw = $('.th-slot[data-k="' + sel + '"] i'); if(sw) sw.style.background = hex;
    });
    $('.th-file').onchange = function(){ var f = this.files[0]; if(f) loadImg(f, function(d){ var t = cur(); try { localStorage.setItem(KEY + '_img_' + t.id, d); } catch(err){ alert('Картинка не помещается в хранилище браузера. Возьмите поменьше.'); return; } IC[t.id] = d; t.img = true; apply(); save(); }); this.value = ''; };
    $('.th-sel').onchange = function(){ st.active = this.value; save(); apply(); refresh(); };
    $('.th-slots').addEventListener('click', function(e){ if(e.target.dataset.l != null){ cur().layers.splice(+e.target.dataset.l, 1); if(sel[0] === 'L') sel = 'acc'; apply(); save(); fillSlots(); picker.set(getc(sel)); return; } var s = e.target.closest('.th-slot'); if(!s) return; sel = s.dataset.k; fillSlots(); picker.set(getc(sel)); });
    var pal = $('.th-pal');
    pal.addEventListener('click', function(e){ var i = e.target.closest('i'); if(!i) return; var c = st.palette[+i.dataset.i]; setc(sel, c); apply(); save(); fillSlots(); picker.set(c); });
    pal.addEventListener('dblclick', function(e){ var i = e.target.closest('i'); if(!i) return; st.palette[+i.dataset.i] = picker.hex(); save(); fillPal(); });
    pal.addEventListener('contextmenu', function(e){ var i = e.target.closest('i'); if(!i) return; e.preventDefault(); st.palette.splice(+i.dataset.i, 1); save(); fillPal(); });
    $('.th-sl').addEventListener('input', function(e){ var k = e.target.dataset.s; if(!k) return; cur()[k] = +e.target.value; e.target.parentNode.querySelector('b').textContent = e.target.value + (k == 'blur' ? 'px' : '%'); apply(); save(); });
    box.addEventListener('click', function(e){
      var a = e.target.dataset && e.target.dataset.a; if(!a) return;
      if(a === 'x') close();
      else if(a === 'ladd'){ cur().layers.push('#00000066'); sel = 'L' + (cur().layers.length - 1); apply(); save(); fillSlots(); picker.set(getc(sel)); }
      else if(a === 'img') $('.th-file').click();
      else if(a === 'imgx'){ try { localStorage.removeItem(KEY + '_img_' + cur().id); } catch(_){} delete IC[cur().id]; cur().img = false; apply(); save(); }
      else if(a === 'padd'){ var c = picker.hex(); if(st.palette.indexOf(c) < 0){ st.palette.push(c); save(); fillPal(); } }
      else if(a === 'new'){ var n = prompt('Название темы:', 'Моя тема'); if(!n) return; var old = cur().id, t = clone(cur()); t.id = 't' + Date.now(); t.name = n; try { var d0 = localStorage.getItem(KEY + '_img_' + old); if(d0) localStorage.setItem(KEY + '_img_' + t.id, d0); } catch(_){} st.themes.push(t); st.active = t.id; save(); apply(); refresh(); }
      else if(a === 'del'){ if(st.themes.length < 2){ alert('Последнюю тему удалить нельзя.'); return; } if(!confirm('Удалить тему «' + cur().name + '»?')) return; try { localStorage.removeItem(KEY + '_img_' + st.active); } catch(_){} st.themes = st.themes.filter(function(t){ return t.id !== st.active; }); st.active = st.themes[0].id; save(); apply(); refresh(); }
      else if(a === 'reset'){ var t2 = cur(); t2.vars = clone(DEF); t2.bright = t2.sat = t2.fbright = t2.fsat = 100; t2.layers = []; t2.panelA = 70; t2.blur = 0; t2.img = false; sel = 'acc'; try { localStorage.removeItem(KEY + '_img_' + t2.id); } catch(_){} delete IC[t2.id]; save(); apply(); refresh(); }
    });
    refresh();
  }

  // ── вкладки «API» / «Стиль» внутри окна «⚙ Настройки», которое встраивает сервер ──
  function tabify(){
    var m = document.getElementById('lab-mistral-settings'), panel = m && m.querySelector('.panel');
    if(!panel) return null;
    if(m.dataset.tabs) return m;
    m.dataset.tabs = '1';
    var bar = document.createElement('div'), api = document.createElement('div'), sty = document.createElement('div');
    bar.className = 'st-tabs'; bar.innerHTML = '<button type="button" data-t="api" class="on">API</button><button type="button" data-t="style">Стиль</button>';
    api.className = 'st-pane'; sty.className = 'st-pane th-emb'; sty.hidden = true;
    while(panel.firstChild) api.appendChild(panel.firstChild);   // прежнее содержимое (ключ Mistral и т.д.) целиком уходит во вкладку API
    var h = api.querySelector('#lab-mistral-title'); if(h) h.textContent = 'Сервисы и ключи';
    var d = api.querySelector('p'); if(d && d.id !== 'lab-mistral-status') d.textContent = 'Ключи хранятся только в этом браузере и уходят на ваш локальный сервер лишь тогда, когда сервис используется.';
    var lb = api.querySelector('label[for="lab-mistral-key"]'), inp = api.querySelector('#lab-mistral-key');
    if(lb && inp){
      var card = document.createElement('div'), hd = document.createElement('div');
      card.className = 'svc'; hd.className = 'svc-h'; hd.innerHTML = '<b>Mistral</b><span>API-ключ</span>';
      lb.className = 'svc-sr'; lb.parentNode.insertBefore(card, lb); card.appendChild(hd); card.appendChild(lb); card.appendChild(inp);
    }
    panel.appendChild(bar); panel.appendChild(api); panel.appendChild(sty);
    // «⚙ Настройки» всегда открываются на вкладке «Стиль»
    var op = document.getElementById('lab-mistral-open'); if(op) op.addEventListener('click', function(){ show('style'); });
    // всё, что позже добавит другой скрипт (ai-settings.js), тоже попадает во вкладку API
    new MutationObserver(function(ms){ ms.forEach(function(r){ [].forEach.call(r.addedNodes, function(n){ if(n.parentNode === panel && n !== bar && n !== api && n !== sty) api.appendChild(n); }); }); }).observe(panel, { childList:true });
    bar.addEventListener('click', function(e){ var t = e.target.dataset && e.target.dataset.t; if(t) show(t); });
    return m;
  }
  function show(t){
    var m = tabify(); if(!m) return;
    var panel = m.querySelector('.panel'), sty = panel.querySelector('.th-emb'), api = panel.querySelector('.st-pane');
    [].forEach.call(panel.querySelectorAll('.st-tabs button'), function(b){ b.classList.toggle('on', b.dataset.t === t); });
    api.hidden = t !== 'api'; sty.hidden = t !== 'style';
    m.classList.toggle('th-wide', t === 'style');
    if(t === 'style' && !sty.dataset.built){ sty.dataset.built = '1'; build(sty); }
  }
  function open(){ var m = tabify(); if(!m) return; m.style.display = 'flex'; show('style'); }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tabify); else tabify();
  window.addEventListener('load', tabify);
  window.codelabTheme = { open:open };
})();
