// Окно «🧭 задачи» в песочнице: выбрать задачу → пройти вопросы → вставить собранный код в редактор;
// вкладка «🩹 проверка» — что в открытых файлах оборвано (незакрытые скобки/кавычки, имена без источника)
// и какие куски/задачи это закрывают. Галочка «🩹 оборванное» подсвечивает это прямо в коде.
// Надстройка песочницы; после tabs.js и win.js. Подключён на constructor.html.
(function(){
  const sb = window.codelabSandbox;
  const box = document.getElementById('sandbox');
  const edsEl = box && box.querySelector('#sbEds');
  const bar = box && box.querySelector('.sb-bar');

  // задачи со страницы «Задачи» → «▶ в песочницу»: файлы ждут в localStorage до открытия конструктора
  try {
    const pend = JSON.parse(localStorage.getItem('codelab_open_pending') || 'null');
    if(Array.isArray(pend) && pend.length && window.codelabOpenInEditor){
      localStorage.removeItem('codelab_open_pending');
      setTimeout(() => pend.forEach(f => window.codelabOpenInEditor(f.name, f.lang, f.code)), 50);
    }
  } catch(_){}

  if(!sb || !box || !edsEl || !bar || !window.TaskWalk || !window.CodeCheck){ return; }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const api = (u, b) => fetch(u, b === undefined ? undefined : { method: 'POST', body: JSON.stringify(b) }).then(r => r.json());
  const activeId = () => { try { return localStorage.getItem('codelab_sb_active'); } catch(_){ return null; } };
  const edFor = id => { for(const ed of edsEl.children){ if(ed.__f && ed.__f.id === id) return ed; } return null; };
  const activeFile = () => { const fs = sb.getFiles(); return fs.find(f => f.id === activeId()) || fs[0] || null; };
  const taOf = ed => ed && ed.querySelector('textarea');

  const st = document.createElement('style');
  st.textContent = `
  .tp{position:fixed;z-index:9997;display:none;flex-direction:column;background:var(--bg2,#150a2b);border:1px solid var(--border,#3a2f55);border-radius:12px;box-shadow:0 10px 32px rgba(0,0,0,.5);overflow:hidden}
  .tp.on{display:flex}
  .tp .th{display:flex;align-items:center;gap:6px;padding:7px 9px;border-bottom:1px solid var(--border,#3a2f55);font-size:12.5px}
  .tp .th b{flex:1}
  .tp .th button.x{background:none;border:0;color:var(--text2,#cbc2ea);cursor:pointer;font-size:14px;padding:2px 5px}
  .tp .tabs{display:flex;gap:2px}
  .tp .tabs button{background:none;border:0;border-bottom:2px solid transparent;color:var(--text3,#9c90c4);font:12px system-ui,sans-serif;padding:4px 7px;cursor:pointer}
  .tp .tabs button.on{color:var(--text,#eee);border-bottom-color:var(--name,#3dd9ff)}
  .tp .tb{flex:1;min-height:0;overflow:auto;padding:9px 11px}
  .tp input.q{width:100%;box-sizing:border-box;background:var(--bg,#0e0720);border:1px solid var(--border,#3a2f55);border-radius:8px;color:var(--text,#eee);font-size:12.5px;padding:7px 9px;margin-bottom:6px}
  .tp .it{padding:6px 8px;border-radius:7px;cursor:pointer}
  .tp .it:hover{background:var(--s2,#1a1030)}
  .tp .it .t{font-size:12.5px;color:var(--text,#eee)}
  .tp .it .d{font-size:11px;color:var(--text3,#9c90c4);line-height:1.4}
  .tp .grp{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--text3,#9c90c4);margin:9px 0 3px}
  .tp .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:6px 0}
  .tp .muted{color:var(--text3,#9c90c4);font-size:12px;line-height:1.5}
  .tp .ok{color:var(--str,#52F2C9);font-size:12px}
  .tp .iss{border:1px solid var(--border,#3a2f55);border-radius:8px;padding:6px 8px;margin:5px 0;font-size:12px}
  .tp .iss .w{cursor:pointer;color:var(--text,#eee)}
  .tp .iss .w:hover{color:var(--acc,#ff2fae)}
  .tp .iss b{font-family:ui-monospace,monospace;color:var(--fn,#ff2fae)}
  .tp .iss .sg{margin-top:4px;display:flex;flex-direction:column;gap:2px}
  .tp .iss .sg a{color:var(--name,#3dd9ff);cursor:pointer;font-size:11.5px}
  .tp .iss .sg a:hover{text-decoration:underline}
  .tp .asm{margin-top:10px;border-top:1px solid var(--border,#3a2f55);padding-top:8px}
  .tp-hint{display:none;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 6px;margin:0 0 4px;font-size:12px;color:var(--text3,#9c90c4);background:var(--bg2,#150a2b);border:1px solid var(--border,#3a2f55);border-radius:8px}
  .tp-hint.on{display:flex}
  .tp-hint .c{display:inline-flex;align-items:center;gap:5px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:var(--s2,#1a1030);border:1px solid var(--border,#3a2f55);border-radius:7px;padding:3px 4px 3px 8px;cursor:pointer;color:var(--text,#eee)}
  .tp-hint .c:hover{border-color:var(--kw,#b45cff)}
  .tp-hint .c i{font-style:normal;color:var(--text3,#9c90c4);font-size:11px}
  .tp-hint .c .x{background:none;border:0;color:var(--text3,#9c90c4);cursor:pointer;font-size:12px;padding:0 3px}
  .tp-hint .c .x:hover{color:var(--acc,#ff2fae)}
  .cl-broken{background:rgba(255,80,80,.28);border-radius:2px;outline:1px solid rgba(255,80,80,.7)}
  .cl-unmet{text-decoration:underline wavy rgba(255,170,60,.95);text-decoration-skip-ink:none;text-underline-offset:3px}
  .cl-bad-line{background:rgba(255,80,80,.07)}
  `;
  document.head.appendChild(st);

  const panel = document.createElement('div'); panel.className = 'tp';
  panel.innerHTML = '<div class="th"><b>🧭</b><span class="tabs"><button data-t="tasks" class="on">задачи</button><button data-t="check">🩹 проверка</button></span><span style="flex:1"></span><button class="x" title="закрыть">×</button></div>'
    + '<div class="tb" id="tpBody"></div>';
  document.body.appendChild(panel);
  const body = panel.querySelector('#tpBody');
  if(window.codelabWindow) window.codelabWindow.make(panel, { handle: panel.querySelector('.th'), key: 'codelab_win_tp', defaultGeo: { w: 400, h: 560 }, minW: 280, minH: 240 });
  panel.querySelector('.x').onclick = () => panel.classList.remove('on');
  let tab = 'tasks';
  panel.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { tab = b.dataset.t; panel.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b)); draw(); });

  const btn = document.createElement('button'); btn.className = 'btn'; btn.textContent = '🧭 задачи';
  btn.title = 'задачи: выбрать, что хочешь сделать, ответить на вопросы и вставить код; проверка оборванного';
  btn.onclick = () => { const on = !panel.classList.contains('on'); panel.classList.toggle('on', on); if(on) draw(); };
  const lab = document.createElement('label'); lab.className = 'sb-live';
  lab.title = 'подсвечивать в коде незакрытые скобки/кавычки (красным) и имена, которые нигде не заданы (волнистым)';
  lab.innerHTML = '<input type="checkbox"> 🩹 оборванное';
  const chk = lab.querySelector('input');
  try { chk.checked = localStorage.getItem('codelab_broken') === '1'; } catch(_){}
  const legend = bar.querySelector('#sbLegend'); if(legend){ legend.after(lab); legend.after(btn); } else { bar.appendChild(btn); bar.appendChild(lab); }

  // ── вставка кода ──
  function insertInto(ed, code){
    const ta = taOf(ed), cm = ta && ta.__cm;
    if(cm){ const cur = cm.getCursor(); const line = cm.getLine(cur.line) || ''; const pre = line.trim() ? '\n' : ''; cm.replaceRange(pre + code + '\n', cur); cm.focus(); return; }
    if(ta){ const p = ta.selectionStart; ta.value = ta.value.slice(0, p) + '\n' + code + '\n' + ta.value.slice(p); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); }
  }
  // в открытый файл того же языка (активный — первым), иначе новой вкладкой
  function insertCode(lang, code, name){
    const fs = sb.getFiles(); const a = activeFile();
    const f = (a && a.lang === lang) ? a : fs.find(x => x.lang === lang);
    const ed = f && edFor(f.id);
    if(ed){ insertInto(ed, code); return; }
    if(window.codelabOpenInEditor) window.codelabOpenInEditor(name || ('код.' + lang), lang, code);
  }

  // ── вкладка «задачи» ──
  let TASKS = null, curTask = null, walk = null, lastAsm = [];
  async function drawTasks(){
    if(curTask) return drawWalk();
    TASKS = await api('/api/tasks/list').catch(() => []);
    const af = activeFile();
    body.innerHTML = '<input class="q" placeholder="что хочу сделать…">'
      + '<div id="tpList"></div>'
      + '<div class="muted" style="margin-top:10px">Задачи пишутся и правятся на странице <a href="/tasks.html" style="color:var(--name)">Задачи</a>.</div>';
    const q = body.querySelector('input.q'), host = body.querySelector('#tpList');
    const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е');
    const render = () => {
      const w = norm(q.value).split(/\s+/).filter(Boolean);
      // язык активного файла — первым: задачи «про этот код» выше
      const list = TASKS.filter(t => { const h = norm([t.title, t.group, (t.aliases || []).join(' ')].join(' ')); return w.every(x => h.includes(x)); })
        .sort((a, b) => ((b.lang === (af && af.lang)) - (a.lang === (af && af.lang))) || a.title.localeCompare(b.title, 'ru'));
      host.innerHTML = list.length ? '' : '<div class="muted">' + (TASKS.length ? 'ничего не нашлось' : 'задач пока нет — их можно написать на странице «Задачи» или загрузить ответом ИИ') + '</div>';
      list.slice(0, 80).forEach(t => {
        const d = document.createElement('div'); d.className = 'it';
        d.innerHTML = '<div class="t">' + esc(t.title) + '</div><div class="d">' + esc((t.lang || '').toUpperCase() + (t.group ? ' · ' + t.group : '')) + '</div>';
        d.onclick = async () => { curTask = await api('/api/tasks/get?id=' + encodeURIComponent(t.id)).catch(() => null); drawWalk(); };
        host.appendChild(d);
      });
    };
    q.oninput = render; render(); q.focus();
  }
  async function drawWalk(){
    const t = curTask; if(!t){ curTask = null; return drawTasks(); }
    body.innerHTML = '<div class="row"><button class="btn" id="tpBack">‹ все задачи</button><button class="btn" id="tpReset">↺</button>'
      + '<a class="btn" href="/tasks.html?id=' + encodeURIComponent(t.id) + '" target="_blank" title="открыть на странице задач">✎</a></div>'
      + '<div style="font-weight:600;font-size:13.5px;margin:2px 0 4px">' + esc(t.title) + '</div>'
      + (t.desc ? '<div class="muted" style="margin-bottom:6px">' + esc(t.desc) + '</div>' : '')
      + '<div id="tpWalk"></div><div class="asm" id="tpAsm"></div>';
    body.querySelector('#tpBack').onclick = () => { curTask = null; drawTasks(); };
    walk = TaskWalk.mount(body.querySelector('#tpWalk'), t, { stepMode: true, simple: true, onChange: asm => { lastAsm = asm; drawAsm(); } });
    body.querySelector('#tpReset').onclick = () => walk.reset();
    refreshHave();
  }
  function drawAsm(){
    const host = body.querySelector('#tpAsm'); if(!host) return;
    const parts = TaskWalk.joinAssembly(lastAsm);
    if(!parts.length){ host.innerHTML = '<div class="muted">Выбранные варианты соберутся здесь — потом вставишь их в редактор.</div>'; return; }
    host.innerHTML = '';
    parts.forEach(p => {
      const r = document.createElement('div'); r.className = 'row';
      r.innerHTML = '<span class="muted" style="flex:1">' + esc(p.lang.toUpperCase()) + ' · ' + p.list.map(a => esc(a.title)).join(', ') + '</span>';
      const b = document.createElement('button'); b.className = 'btn ok'; b.textContent = '⤵ вставить';
      b.title = 'вставить в место курсора открытого ' + p.lang.toUpperCase() + '-файла (или новой вкладкой)';
      b.onclick = () => { insertCode(p.lang, p.code, 'задача.' + p.lang); setTimeout(refreshHave, 300); };
      r.appendChild(b); host.appendChild(r);
    });
  }
  // «✓ уже есть в коде» у вариантов: что объявлено во всех открытых файлах
  async function refreshHave(){
    if(!walk) return;
    const r = await api('/api/code/next', { files: sb.getFiles().map(f => ({ name: f.name, lang: f.lang, code: f.code })) }).catch(() => null);
    if(r && walk) walk.setHave(new Set(r.provided || []));
  }

  // ── вкладка «проверка» ──
  async function drawCheck(){
    body.innerHTML = '<div class="muted">проверяю открытые файлы…</div>';
    const files = sb.getFiles();
    const [next] = await Promise.all([api('/api/code/next', { files: files.map(f => ({ name: f.name, lang: f.lang, code: f.code })) }).catch(() => null)]);
    const issues = files.map(f => ({ f, br: scanBrackets(f.code, f.lang) }));
    body.innerHTML = '';
    let any = false;
    issues.forEach(({ f, br }) => {
      if(!br.length) return; any = true;
      body.insertAdjacentHTML('beforeend', '<div class="grp">' + esc(f.name) + ' — скобки и кавычки</div>');
      br.slice(0, 20).forEach(x => {
        const d = document.createElement('div'); d.className = 'iss';
        d.innerHTML = '<span class="w">строка ' + (x.line + 1) + ': ' + esc(x.msg) + '</span>';
        d.querySelector('.w').onclick = () => jump(f, x.from, x.to);
        body.appendChild(d);
      });
    });
    const unmet = next ? next.unmet.filter(u => !u.generic) : [];
    if(unmet.length){
      any = true;
      body.insertAdjacentHTML('beforeend', '<div class="grp">Имена, которые нигде не заданы</div>');
      unmet.slice(0, 40).forEach(u => {
        const f = files.find(x => x.name === u.file);
        const d = document.createElement('div'); d.className = 'iss';
        d.innerHTML = '<span class="w"><b>' + esc(u.name) + '</b> — ' + esc(u.file) + '</span><div class="muted">' + esc(needText(u.name)) + '</div><div class="sg"></div>';
        d.querySelector('.w').onclick = () => { if(f){ const p = window.CodeCheck.namePositions(f.code, u.name)[0]; if(p) jump(f, p.from, p.to); } };
        const sg = d.querySelector('.sg');
        u.tasks.forEach(t => { const a = document.createElement('a'); a.textContent = '🧭 ' + t.title; a.onclick = async () => { curTask = await api('/api/tasks/get?id=' + encodeURIComponent(t.id)).catch(() => null); setTab('tasks'); }; sg.appendChild(a); });
        u.pieces.slice(0, 4).forEach(p => { const a = document.createElement('a'); a.textContent = '⤵ ' + p.title + (p.needs.length ? '  (сам требует: ' + p.needs.slice(0, 3).join(', ') + ')' : '');
          a.title = 'вставить этот кусок в место курсора'; a.onclick = async () => { insertCode(p.lang, await TaskWalk.codeOf(p.id), p.title + '.' + p.lang); setTimeout(drawCheck, 300); }; sg.appendChild(a); });
        if(!u.tasks.length && !u.pieces.length) sg.innerHTML = '<span class="muted">готового куска для этого в библиотеке нет</span>';
        body.appendChild(d);
      });
    }
    if(!any) body.innerHTML = '<div class="ok">✓ Ничего оборванного не нашлось: скобки и кавычки закрыты, все имена где-то заданы.</div>';
    body.insertAdjacentHTML('beforeend', '<div class="muted" style="margin-top:10px">Проверка простая, по тексту: имена из чужих библиотек и глобальные объекты браузера иногда попадают сюда зря.</div>');
  }
  function setTab(t){ tab = t; panel.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x.dataset.t === t)); draw(); }
  function draw(){ if(tab === 'check') drawCheck(); else drawTasks(); }

  const scanBrackets = (code, lang) => window.CodeCheck.scanBrackets(code, lang);
  const needText = n => window.CodeCheck.needText(n);

  function jump(f, from, to){
    if(window.codelabTabs) window.codelabTabs.setActive(f.id);
    const ed = edFor(f.id), ta = taOf(ed), cm = ta && ta.__cm;
    if(cm){ const a = cm.posFromIndex(from), b = cm.posFromIndex(to); cm.setSelection(a, b); cm.scrollIntoView({ from: a, to: b }, 80); cm.focus(); }
    else if(ta){ ta.focus(); try { ta.setSelectionRange(from, to); } catch(_){} }
  }

  // ── подсветка в редакторе (только CodeMirror: у обычного поля нет разметки поверх текста) ──
  const MARKS = new Map();   // cm → [mark|{line}]
  function clearMarks(){ for(const [cm, arr] of MARKS){ arr.forEach(m => { if(m.clear) m.clear(); else cm.removeLineClass(m.line, 'background', 'cl-bad-line'); }); } MARKS.clear(); }
  let hlSeq = 0;
  async function highlight(){
    const my = ++hlSeq;
    if(!chk.checked){ clearMarks(); return; }
    const files = sb.getFiles();
    const next = await api('/api/code/next', { files: files.map(f => ({ name: f.name, lang: f.lang, code: f.code })) }).catch(() => null);
    if(my !== hlSeq) return;
    clearMarks();
    for(const f of files){
      const cm = (taOf(edFor(f.id)) || {}).__cm; if(!cm) continue;
      const arr = []; MARKS.set(cm, arr);
      cm.operation(() => {
        for(const x of scanBrackets(f.code, f.lang)){
          arr.push(cm.markText(cm.posFromIndex(x.from), cm.posFromIndex(x.to), { className: 'cl-broken', title: x.msg }));
          const h = cm.addLineClass(x.line, 'background', 'cl-bad-line'); arr.push({ line: h });
        }
        if(next) for(const u of next.unmet){ if(u.generic || u.file !== f.name) continue;
          const hint = needText(u.name) + (u.pieces.length ? ' — даёт кусок «' + u.pieces[0].title + '» (🧭 → проверка)' : '');
          for(const p of window.CodeCheck.namePositions(f.code, u.name)) arr.push(cm.markText(cm.posFromIndex(p.from), cm.posFromIndex(p.to), { className: 'cl-unmet', title: hint })); }
      });
    }
  }
  let hlTimer = null;
  const schedule = () => { clearTimeout(hlTimer); hlTimer = setTimeout(() => { highlight(); if(panel.classList.contains('on') && tab === 'check') drawCheck(); }, 900); };
  chk.onchange = () => { try { localStorage.setItem('codelab_broken', chk.checked ? '1' : '0'); } catch(_){} highlight(); };
  edsEl.addEventListener('input', schedule, true);
  edsEl.addEventListener('keyup', schedule, true);
  new MutationObserver(schedule).observe(edsEl, { childList: true });
  if(chk.checked) setTimeout(highlight, 800);

  async function openTask(id){
    curTask = await api('/api/tasks/get?id=' + encodeURIComponent(id)).catch(() => null);
    panel.classList.add('on'); setTab('tasks');
  }
  // ── полоска «🧭 пригодится»: до 3 задач к открытому коду, сама, без кликов ──
  const hint = document.createElement('div'); hint.className = 'tp-hint';
  edsEl.before(hint);
  const hLab = document.createElement('label'); hLab.className = 'sb-live';
  hLab.title = 'над редактором сами появляются задачи, которые подходят к открытому коду (чего не хватает, что начато)';
  hLab.innerHTML = '<input type="checkbox"> 🧭 подсказки';
  const hChk = hLab.querySelector('input');
  try { hChk.checked = localStorage.getItem('codelab_task_hints') !== '0'; } catch(_){ hChk.checked = true; }
  lab.after(hLab);
  const hidden = new Set();   // ✕ — до перезагрузки страницы
  let hSeq = 0;
  async function suggest(){
    const my = ++hSeq;
    if(!hChk.checked){ hint.classList.remove('on'); return; }
    const f = activeFile(); if(!f || !String(f.code || '').trim()){ hint.classList.remove('on'); return; }
    // код у курсора: ±200 строк для похожести, текущая и прошлая строки — для слов
    const lines = String(f.code).split('\n'); let ln = lines.length - 1;
    const cm = (taOf(edFor(f.id)) || {}).__cm; if(cm) ln = cm.getCursor().line;
    const win = lines.slice(Math.max(0, ln - 200), ln + 200).join('\n');
    const cursor = lines.slice(Math.max(0, ln - 1), ln + 1).join('\n');
    const r = await api('/api/tasks/suggest', { files: sb.getFiles().map(x => ({ name: x.name, lang: x.lang, code: x.code })), lang: f.lang, window: win, cursor }).catch(() => null);
    if(my !== hSeq) return;
    const hits = ((r && r.hits) || []).filter(h => !hidden.has(h.id));
    if(!hits.length){ hint.classList.remove('on'); return; }
    hint.innerHTML = '<span>🧭 пригодится:</span>';
    hits.forEach(h => {
      const c = document.createElement('span'); c.className = 'c'; c.title = h.why.join(' · ') + '  (балл ' + h.score + ')';
      c.innerHTML = esc(h.title) + (h.why[0] ? ' <i>' + esc(h.why[0]) + '</i>' : '') + '<button class="x" title="не предлагать до перезагрузки">✕</button>';
      c.onclick = e => { if(e.target.closest('.x')){ hidden.add(h.id); c.remove(); if(!hint.querySelector('.c')) hint.classList.remove('on'); return; } openTask(h.id); };
      hint.appendChild(c);
    });
    hint.classList.add('on');
  }
  let sTimer = null;
  const scheduleSuggest = () => { clearTimeout(sTimer); sTimer = setTimeout(suggest, 1500); };
  edsEl.addEventListener('input', scheduleSuggest, true);
  edsEl.addEventListener('keyup', scheduleSuggest, true);
  edsEl.addEventListener('mouseup', scheduleSuggest, true);
  new MutationObserver(scheduleSuggest).observe(edsEl, { childList: true });
  hChk.onchange = () => { try { localStorage.setItem('codelab_task_hints', hChk.checked ? '1' : '0'); } catch(_){} suggest(); };
  setTimeout(suggest, 1200);

  window.codelabTaskPanel = { open: () => { panel.classList.add('on'); draw(); }, openTask, scanBrackets };
})();
