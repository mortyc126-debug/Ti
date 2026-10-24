// Поиск в песочнице: внутри открытого файла и «по приёмам» (цикл, условие, функция… → реальные конструкции кода).
// Надстройка над window.codelabSandbox; подключать после tabs.js (нужен window.codelabTabs для перехода между файлами).
// Работает и с CodeMirror (через ta.__cm, только core-методы), и с обычной textarea.
(function(){
  const sb = window.codelabSandbox;
  const box = document.getElementById('sandbox');
  if(!sb || !box){ return; }
  const col = box.querySelector('.sb-edcol') || box.querySelector('#sbEds').parentNode;
  const edsEl = box.querySelector('#sbEds');
  if(!col || !edsEl){ return; }

  // «приёмы»: человеческое слово → что искать в коде (регулярками, без учёта регистра)
  const TRICKS = {
    'цикл': ['for','while','forEach','\\.map\\(','do '],
    'условие': ['if','else','switch','\\?.*:','case '],
    'функция': ['function','=>','def ','func '],
    'массив': ['\\[\\]','Array','\\.push\\(','\\.map\\(','\\.filter\\('],
    'объект': ['\\{\\}','Object','\\bthis\\b','=>'],
    'класс': ['class ','new '],
    'импорт': ['import ','require\\(','from '],
    'вывод': ['console\\.log','print','echo','alert\\(','document\\.write'],
    'переменная': ['\\blet\\b','\\bconst\\b','\\bvar\\b'],
    'событие': ['addEventListener','onclick','\\.on\\('],
    'ошибка': ['try','catch','throw','Error'],
    'запрос': ['fetch\\(','XMLHttpRequest','axios','\\.ajax']
  };

  const files = () => sb.getFiles();
  function activeId(){ try { return localStorage.getItem('codelab_sb_active'); } catch(_){ return null; } }
  function activeFile(){ const fs = files(); return fs.find(f => f.id === activeId()) || fs[0] || null; }
  // DOM-редактор (и его textarea/CM) для файла по id
  function edFor(id){ for(const ed of edsEl.children){ if(ed.__f && ed.__f.id === id) return ed; } return null; }
  function taFor(id){ const ed = edFor(id); return ed ? ed.querySelector('textarea') : null; }

  // ── стили ──
  const st = document.createElement('style');
  st.textContent = `
  .sb-find{display:none;gap:6px;align-items:center;padding:5px 8px;border-bottom:1px solid var(--border,#3a2f55);background:var(--bg2,#150a2b);flex-wrap:wrap}
  .sb-find.on{display:flex}
  .sb-find input.q{flex:1;min-width:120px;background:var(--bg,#0e0720);color:var(--text,#eee);border:1px solid var(--border,#3a2f55);border-radius:6px;padding:4px 8px;font:13px monospace}
  .sb-find .cnt{font-size:12px;color:var(--muted,#9a93b5);min-width:48px;text-align:center}
  .sb-find .btn{padding:3px 8px}
  .sb-find .mode{display:flex;gap:2px;font-size:12px;align-items:center}
  .sb-find label.ci{font-size:12px;color:var(--muted,#9a93b5);display:flex;align-items:center;gap:3px;cursor:pointer}
  .sb-find .seg{border:1px solid var(--border,#3a2f55);border-radius:6px;overflow:hidden;display:flex}
  .sb-find .seg button{background:transparent;color:var(--muted,#9a93b5);border:0;padding:3px 9px;cursor:pointer;font-size:12px}
  .sb-find .seg button.on{background:var(--acc,#52F2C9);color:#06231c}
  .cm-find{background:rgba(255,200,60,.28);border-radius:2px}
  .cm-find-cur{background:rgba(255,160,40,.6);border-radius:2px}
  `;
  document.head.appendChild(st);

  // ── панель поиска (под полосой вкладок) ──
  const findBar = document.createElement('div'); findBar.className = 'sb-find'; findBar.id = 'sbFind';
  findBar.innerHTML =
    '<div class="seg"><button data-m="file" class="on" title="искать в открытом файле">в файле</button>' +
    '<button data-m="trick" title="искать приёмы во всех открытых файлах: цикл, условие, функция…">по приёмам</button></div>' +
    '<input class="q" placeholder="что искать…">' +
    '<label class="ci"><input type="checkbox" class="cibox"> Аа</label>' +
    '<span class="cnt">0 / 0</span>' +
    '<button class="btn prev" title="предыдущее (Shift+Enter)">‹</button>' +
    '<button class="btn next" title="следующее (Enter)">›</button>' +
    '<button class="btn x" title="закрыть (Esc)">×</button>';
  col.insertBefore(findBar, edsEl);

  const q = findBar.querySelector('.q'), cntEl = findBar.querySelector('.cnt'), ciBox = findBar.querySelector('.cibox');
  let mode = 'file', matches = [], cur = -1, marks = [];
  const lastPos = new Map();  // id файла → смещение последнего совпадения (чтобы «начать с последнего»)

  function clearMarks(){ marks.forEach(m => { try { m.clear(); } catch(_){} }); marks = []; }

  function findIn(code, rx){
    const out = []; let m; rx.lastIndex = 0;
    while((m = rx.exec(code))){ if(m[0] === ''){ rx.lastIndex++; continue; } out.push([m.index, m.index + m[0].length]); }
    return out;
  }
  function buildRegex(){
    const ci = !ciBox.checked;  // по умолчанию без учёта регистра; галочка «Аа» включает учёт
    const flags = 'g' + (ci ? 'i' : '');
    const text = q.value;
    if(!text) return null;
    if(mode === 'trick'){
      const key = text.trim().toLowerCase();
      const parts = TRICKS[key] || [text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')];
      return new RegExp('(' + parts.join('|') + ')', flags);
    }
    return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }

  function run(keepCur){
    clearMarks(); matches = [];
    const rx = buildRegex();
    if(!rx){ cntEl.textContent = '0 / 0'; cur = -1; return; }
    const scope = mode === 'trick' ? files() : [activeFile()].filter(Boolean);
    scope.forEach(f => { findIn(f.code || '', rx).forEach(([s, e]) => matches.push({ id: f.id, s, e })); });
    // подсветить все совпадения в их CM-редакторах
    matches.forEach(mt => mark(mt, false));
    if(!matches.length){ cntEl.textContent = '0 / 0'; cur = -1; return; }
    if(!keepCur){
      // начать с последнего места в активном файле, иначе с первого
      const af = activeFile(); const last = af ? lastPos.get(af.id) : null;
      cur = 0;
      if(last != null){ const i = matches.findIndex(mt => mt.id === af.id && mt.s >= last); if(i >= 0) cur = i; }
    }
    cur = Math.max(0, Math.min(cur, matches.length - 1));
    show();
  }

  function cmOf(id){ const ta = taFor(id); return ta && ta.__cm ? ta.__cm : null; }
  function mark(mt, isCur){
    const cm = cmOf(mt.id); if(!cm) return;
    try { const from = cm.posFromIndex(mt.s), to = cm.posFromIndex(mt.e);
      marks.push(cm.markText(from, to, { className: isCur ? 'cm-find-cur' : 'cm-find' })); } catch(_){}
  }
  function show(){
    cntEl.textContent = (cur + 1) + ' / ' + matches.length;
    const mt = matches[cur]; if(!mt) return;
    lastPos.set(mt.id, mt.s);
    // перейти к файлу совпадения
    if(mt.id !== activeId() && window.codelabTabs && window.codelabTabs.setActive) window.codelabTabs.setActive(mt.id, false);
    const ta = taFor(mt.id), cm = ta && ta.__cm;
    if(cm){
      clearMarks(); matches.forEach((x, i) => mark(x, i === cur));  // текущий — ярче
      const from = cm.posFromIndex(mt.s), to = cm.posFromIndex(mt.e);
      cm.setSelection(from, to); cm.scrollIntoView({ from, to }, 60);
    } else if(ta){
      ta.focus(); try { ta.setSelectionRange(mt.s, mt.e); } catch(_){}
    }
  }
  function step(d){ if(!matches.length) return; cur = (cur + d + matches.length) % matches.length; show(); }

  function open(){
    findBar.classList.add('on');
    const af = activeFile(); let sel = '';
    const cm = af && cmOf(af.id); if(cm){ try { sel = cm.getSelection(); } catch(_){} }
    if(sel && sel.length < 60) q.value = sel;
    q.focus(); q.select(); run();
  }
  function close(){ findBar.classList.remove('on'); clearMarks(); matches = []; cur = -1; }

  findBar.querySelectorAll('.seg button').forEach(b => b.onclick = () => {
    findBar.querySelectorAll('.seg button').forEach(x => x.classList.remove('on')); b.classList.add('on');
    mode = b.dataset.m; q.placeholder = mode === 'trick' ? 'приём: цикл, условие, функция, массив…' : 'что искать…'; run();
  });
  q.addEventListener('input', () => run());
  ciBox.addEventListener('change', () => run());
  q.addEventListener('keydown', e => {
    if(e.key === 'Enter'){ e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if(e.key === 'Escape'){ e.preventDefault(); close(); }
  });
  findBar.querySelector('.next').onclick = () => step(1);
  findBar.querySelector('.prev').onclick = () => step(-1);
  findBar.querySelector('.x').onclick = close;

  // Ctrl/Cmd+F внутри песочницы открывает поиск
  box.addEventListener('keydown', e => {
    if((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && box.style.display !== 'none'){ e.preventDefault(); open(); }
  }, true);

  // кнопка в панели песочницы
  const bar = box.querySelector('.sb-bar'), legend = bar && bar.querySelector('#sbLegend');
  if(bar){ const b = document.createElement('button'); b.className = 'btn'; b.id = 'sbFindBtn'; b.textContent = '🔎 поиск'; b.title = 'поиск в файле и по приёмам (Ctrl+F)';
    b.onclick = () => findBar.classList.contains('on') ? close() : open();
    if(legend) legend.after(b); else bar.appendChild(b); }

  // если текст в файлах поменялся при открытом поиске — пересчитать (с небольшой задержкой)
  let t = null; edsEl.addEventListener('input', () => { if(findBar.classList.contains('on')){ clearTimeout(t); t = setTimeout(() => run(true), 400); } }, true);

  window.codelabSearch = { open, close };
})();
