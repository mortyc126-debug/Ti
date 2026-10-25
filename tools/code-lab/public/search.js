// Единый поиск в песочнице с фильтрами: что включать — то и ищет.
// Домены (чипы): текст (в открытых файлах), структура (функции/классы/секции), приёмы (конструкции),
// словарь (термины+пояснения), куски (библиотека). Результаты — списком по группам; клик ведёт куда надо.
// Текст и приёмы ещё и подсвечиваются в редакторе и листаются Enter/Shift+Enter.
// Надстройка над window.codelabSandbox; после tabs.js. Работает с CodeMirror и обычной textarea.
(function(){
  const sb = window.codelabSandbox;
  const box = document.getElementById('sandbox');
  if(!sb || !box){ return; }
  const col = box.querySelector('.sb-edcol') || box.querySelector('#sbEds').parentNode;
  const edsEl = box.querySelector('#sbEds');
  if(!col || !edsEl){ return; }

  const TRICKS = {
    'цикл': ['for','while','forEach','\\.map\\(','do '], 'условие': ['if','else','switch','\\?.*:','case '],
    'функция': ['function','=>','def ','func '], 'массив': ['\\[\\]','Array','\\.push\\(','\\.map\\(','\\.filter\\('],
    'объект': ['\\{\\}','Object','\\bthis\\b','=>'], 'класс': ['class ','new '], 'импорт': ['import ','require\\(','from '],
    'вывод': ['console\\.log','print','echo','alert\\(','document\\.write'], 'переменная': ['\\blet\\b','\\bconst\\b','\\bvar\\b'],
    'событие': ['addEventListener','onclick','\\.on\\('], 'ошибка': ['try','catch','throw','Error'], 'запрос': ['fetch\\(','XMLHttpRequest','axios','\\.ajax']
  };

  const files = () => sb.getFiles();
  const activeId = () => { try { return localStorage.getItem('codelab_sb_active'); } catch(_){ return null; } };
  const activeFile = () => { const fs = files(); return fs.find(f => f.id === activeId()) || fs[0] || null; };
  const edFor = id => { for(const ed of edsEl.children){ if(ed.__f && ed.__f.id === id) return ed; } return null; };
  const taFor = id => { const ed = edFor(id); return ed ? ed.querySelector('textarea') : null; };
  const cmOf = id => { const ta = taFor(id); return ta && ta.__cm ? ta.__cm : null; };
  const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // ── стили ──
  const st = document.createElement('style');
  st.textContent = `
  .sb-find{display:none;flex-direction:column;gap:5px;padding:6px 8px;border-bottom:1px solid var(--border,#3a2f55);background:var(--bg2,#150a2b)}
  .sb-find.on{display:flex}
  .sb-find .row1{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  .sb-find input.q{flex:1;min-width:140px;background:var(--bg,#0e0720);color:var(--text,#eee);border:1px solid var(--border,#3a2f55);border-radius:6px;padding:5px 9px;font:13px monospace}
  .sb-find .cnt{font-size:12px;color:var(--muted,#9a93b5);min-width:44px;text-align:center}
  .sb-find .btn{padding:3px 8px}
  .sb-find label.ci{font-size:12px;color:var(--muted,#9a93b5);display:flex;align-items:center;gap:3px;cursor:pointer}
  .sb-find .chips{display:flex;gap:5px;flex-wrap:wrap}
  .sb-find .chip{font-size:11.5px;border:1px solid var(--border,#3a2f55);border-radius:12px;padding:2px 10px;cursor:pointer;color:var(--muted,#9a93b5);background:transparent}
  .sb-find .chip.on{background:var(--acc,#52F2C9);color:#06231c;border-color:var(--acc,#52F2C9)}
  .sb-find-res{max-height:40vh;overflow:auto;font-size:12px}
  .sb-find-res .grp{font-size:11px;color:var(--muted,#9a93b5);text-transform:uppercase;letter-spacing:.04em;margin:6px 0 2px}
  .sb-find-res .r{display:flex;gap:6px;align-items:baseline;padding:2px 5px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden}
  .sb-find-res .r:hover{background:rgba(82,242,201,.12)}
  .sb-find-res .r .fl{color:var(--muted,#9a93b5);flex:none}
  .sb-find-res .r .tx{overflow:hidden;text-overflow:ellipsis}
  .sb-find-res .r .bd{font-size:10px;border-radius:4px;padding:0 5px;flex:none;color:var(--muted,#9a93b5)}
  .sb-find-res .none{color:var(--muted,#9a93b5);font-style:italic;padding:2px 5px}
  .cm-find{background:rgba(255,200,60,.28);border-radius:2px}
  .cm-find-cur{background:rgba(255,160,40,.6);border-radius:2px}
  .sb-find-note{position:fixed;z-index:9999;max-width:360px;background:var(--bg2,#150a2b);color:var(--text,#eee);border:1px solid var(--border,#3a2f55);border-radius:9px;box-shadow:0 8px 28px rgba(0,0,0,.5);padding:9px 11px;font:12.5px/1.5 system-ui,sans-serif;white-space:pre-wrap}
  `;
  document.head.appendChild(st);

  // ── панель ──
  const findBar = document.createElement('div'); findBar.className = 'sb-find'; findBar.id = 'sbFind';
  const DOMAINS = [['text','текст'],['struct','структура'],['trick','приёмы'],['dict','словарь'],['pieces','куски']];
  findBar.innerHTML =
    '<div class="row1"><input class="q" placeholder="искать везде…">' +
    '<label class="ci"><input type="checkbox" class="cibox"> Аа</label>' +
    '<span class="cnt">0 / 0</span>' +
    '<button class="btn prev" title="предыдущее совпадение в тексте (Shift+Enter)">‹</button>' +
    '<button class="btn next" title="следующее совпадение в тексте (Enter)">›</button>' +
    '<button class="btn x" title="закрыть (Esc)">×</button></div>' +
    '<div class="chips">' + DOMAINS.map(([k, t]) => '<button class="chip' + (['text','struct','trick'].includes(k) ? ' on' : '') + '" data-d="' + k + '">' + t + '</button>').join('') + '</div>' +
    '<div class="sb-find-res" id="sbFindRes"></div>';
  col.insertBefore(findBar, edsEl);

  const q = findBar.querySelector('.q'), cntEl = findBar.querySelector('.cnt'), ciBox = findBar.querySelector('.cibox'), resEl = findBar.querySelector('#sbFindRes');
  const enabled = new Set(['text', 'struct', 'trick']);
  let matches = [], cur = -1, marks = [];
  const lastPos = new Map();
  const structCache = new Map();   // id → {code, items}
  let dictData = null, piecesIndex = null, pieceSeq = 0;
  let note = null;

  function clearMarks(){ marks.forEach(m => { try { m.clear(); } catch(_){} }); marks = []; }
  function findIn(code, rx){ const out = []; let m; rx.lastIndex = 0; while((m = rx.exec(code))){ if(m[0] === ''){ rx.lastIndex++; continue; } out.push([m.index, m.index + m[0].length]); } return out; }
  function flags(){ return 'g' + (ciBox.checked ? '' : 'i'); }

  // структура файла (кэш по коду): функции/классы/константы/секции
  function parseStruct(f){
    const c = structCache.get(f.id); if(c && c.code === f.code) return c.items;
    const items = [], lines = String(f.code || '').split('\n'); let base = 0;
    lines.forEach((ln, i) => { const t = ln.trim(); let m;
      if((m = t.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/))) items.push({ kind: 'function', name: m[1], line: i + 1, off: base + ln.indexOf(m[1]) });
      else if((m = t.match(/^class\s+([A-Za-z_$][\w$]*)/))) items.push({ kind: 'class', name: m[1], line: i + 1, off: base + ln.indexOf(m[1]) });
      else if((m = t.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/))) items.push({ kind: 'const', name: m[1], line: i + 1, off: base + ln.indexOf(m[1]) });
      else if((f.lang === 'python') && (m = t.match(/^def\s+([A-Za-z_]\w*)/))) items.push({ kind: 'function', name: m[1], line: i + 1, off: base + ln.indexOf(m[1]) });
      else if((m = t.match(/^(?:\/\/+|#+|\/\*+)[\s*]*[─—=~*#.\-]{2,}\s*([^\n─—=~*#]+?)\s*[─—=~*#.\-]*$/)) && m[1].replace(/[\s─—=~*#.\-]/g, '').length >= 2) items.push({ kind: 'section', name: m[1].trim(), line: i + 1, off: base });
      base += ln.length + 1; });
    structCache.set(f.id, { code: f.code, items }); return items;
  }

  function mark(mt, isCur){ const cm = cmOf(mt.id); if(!cm) return; try { const from = cm.posFromIndex(mt.s), to = cm.posFromIndex(mt.e); marks.push(cm.markText(from, to, { className: isCur ? 'cm-find-cur' : 'cm-find' })); } catch(_){} }
  function jumpTo(id, s, e){
    if(id !== activeId() && window.codelabTabs && window.codelabTabs.setActive) window.codelabTabs.setActive(id, false);
    const ta = taFor(id), cm = ta && ta.__cm;
    if(cm){ const from = cm.posFromIndex(s), to = cm.posFromIndex(e); cm.setSelection(from, to); cm.scrollIntoView({ from, to }, 60); cm.focus(); }
    else if(ta){ ta.focus(); try { ta.setSelectionRange(s, e); } catch(_){} }
  }
  function showNoteAt(text, x, y){ hideNote(); note = document.createElement('div'); note.className = 'sb-find-note'; note.textContent = text; document.body.appendChild(note); note.style.left = Math.max(8, Math.min(x, innerWidth - note.offsetWidth - 12)) + 'px'; note.style.top = Math.max(8, Math.min(y + 14, innerHeight - note.offsetHeight - 12)) + 'px'; }
  function hideNote(){ if(note){ note.remove(); note = null; } }
  document.addEventListener('mousedown', e => { if(note && !note.contains(e.target)) hideNote(); });

  // ── домены ──
  function searchText(query){
    matches = []; clearMarks();
    if(!(enabled.has('text') || enabled.has('trick')) || !query){ cntEl.textContent = '0 / 0'; cur = -1; return []; }
    const rxs = [];
    if(enabled.has('text')) rxs.push(new RegExp(esc(query), flags()));
    if(enabled.has('trick')){ const key = query.trim().toLowerCase(); if(TRICKS[key]) rxs.push(new RegExp('(' + TRICKS[key].join('|') + ')', flags())); }
    files().forEach(f => rxs.forEach(rx => findIn(f.code || '', rx).forEach(([s, e]) => matches.push({ id: f.id, name: f.name, s, e, snip: (f.code || '').slice(Math.max(0, s - 0), e + 24).split('\n')[0] }))));
    matches.sort((a, b) => a.id === b.id ? a.s - b.s : 0);
    matches.forEach(mt => mark(mt, false));
    if(matches.length){ const af = activeFile(); const last = af ? lastPos.get(af.id) : null; cur = 0; if(last != null){ const i = matches.findIndex(mt => mt.id === af.id && mt.s >= last); if(i >= 0) cur = i; } cur = Math.max(0, Math.min(cur, matches.length - 1)); showCur(); }
    else { cntEl.textContent = '0 / 0'; cur = -1; }
    return matches;
  }
  function showCur(){ cntEl.textContent = (cur + 1) + ' / ' + matches.length; const mt = matches[cur]; if(!mt) return; lastPos.set(mt.id, mt.s); const cm = cmOf(mt.id); if(cm){ clearMarks(); matches.forEach((x, i) => mark(x, i === cur)); } jumpTo(mt.id, mt.s, mt.e); }
  function step(d){ if(!matches.length) return; cur = (cur + d + matches.length) % matches.length; showCur(); }

  function searchStruct(query){ if(!enabled.has('struct') || !query) return []; const lq = query.toLowerCase(), out = [];
    files().forEach(f => parseStruct(f).forEach(it => { if(it.name.toLowerCase().includes(lq)) out.push({ fileId: f.id, fileName: f.name, ...it }); })); return out.slice(0, 60); }

  function searchDict(query){ if(!enabled.has('dict') || !query || !dictData) return []; const lq = query.toLowerCase(), out = [], seen = new Set();
    const scan = (obj, where) => { if(!obj) return; for(const [k, v] of Object.entries(obj)){ if(typeof v !== 'string') continue; if(k.toLowerCase().includes(lq) || v.toLowerCase().includes(lq)){ const key = where + '|' + k; if(seen.has(key)) continue; seen.add(key); out.push({ term: k, text: v, where }); } } };
    scan(dictData.words, 'слово'); ['htmlTags','htmlAttrs','cssProps','cssVals'].forEach(s => scan(dictData[s], s));
    if(dictData.langs) for(const l of Object.keys(dictData.langs)) scan(dictData.langs[l], l);
    return out.slice(0, 60); }

  // ── отрисовка результатов ──
  function render(query){
    resEl.innerHTML = '';
    const add = (grp, rows) => { if(!rows.length) return; const g = document.createElement('div'); g.className = 'grp'; g.textContent = grp + ' (' + rows.length + ')'; resEl.appendChild(g); rows.forEach(r => resEl.appendChild(r)); };
    const row = (bd, fl, tx, onClick) => { const d = document.createElement('div'); d.className = 'r'; if(bd){ const b = document.createElement('span'); b.className = 'bd'; b.textContent = bd; d.appendChild(b); } if(fl){ const s = document.createElement('span'); s.className = 'fl'; s.textContent = fl; d.appendChild(s); } const t = document.createElement('span'); t.className = 'tx'; t.textContent = tx; d.appendChild(t); d.onclick = onClick; return d; };

    // текст/приёмы — показываем совпадения списком (клик = прыжок)
    if(enabled.has('text') || enabled.has('trick')){
      const rows = matches.slice(0, 60).map((mt, i) => row('', mt.name + ':' , (mt.snip || '').trim().slice(0, 60), () => { cur = i; showCur(); }));
      add('Текст', rows);
    }
    if(enabled.has('struct')){
      const rows = searchStruct(query).map(it => row(it.kind === 'section' ? '§' : it.kind, it.fileName + ':' + it.line, it.name, () => jumpTo(it.fileId, it.off, it.off + (it.name.length || 1))));
      add('Структура', rows);
    }
    if(enabled.has('dict')){
      const rows = searchDict(query).map(it => row(it.where, '', it.term + ' — ' + it.text.slice(0, 50), e => showNoteAt(it.term + '\n\n' + it.text, e.clientX, e.clientY)));
      add('Словарь', rows);
    }
    if(enabled.has('pieces')){
      const rows = (piecesIndex || []).map(p => row(p.lang || '', '', p.title, () => openPiece(p)));
      add('Куски', rows);
    }
    if(!resEl.children.length && query) resEl.innerHTML = '<div class="none">ничего не нашлось по включённым фильтрам</div>';
  }

  async function openPiece(p){ try { const t = await fetch('/api/template?id=' + encodeURIComponent(p.id)).then(r => r.json()); const code = t.code != null ? t.code : (Array.isArray(t.lines) ? t.lines.map(l => (l || []).map(k => k.v != null ? k.v : '').join('')).join('\n') : ''); if(window.codelabOpenInEditor) window.codelabOpenInEditor(t.title || p.title || 'кусок', t.lang || 'txt', code); } catch(_){} }

  // куски ищутся на сервере (с задержкой), результат кладём в piecesIndex и перерисовываем
  async function searchPieces(query){
    if(!enabled.has('pieces') || !query){ piecesIndex = []; return; }
    const seq = ++pieceSeq;
    try { const r = await fetch('/api/search?q=' + encodeURIComponent(query) + '&limit=40').then(x => x.json());
      if(seq !== pieceSeq) return;
      const hits = (r && r.hits) || [];
      // подтянуть названия (список кусков кэшируем)
      if(!window.__sbPiecesList){ window.__sbPiecesList = await fetch('/api/list').then(x => x.json()).catch(() => []); }
      const byId = {}; (window.__sbPiecesList || []).forEach(p => byId[p.id] = p);
      piecesIndex = hits.map(h => { const p = byId[h.id] || {}; return { id: h.id, title: p.title || h.id, lang: p.lang || '' }; });
      render(q.value.trim());
    } catch(_){ if(seq === pieceSeq) piecesIndex = []; }
  }

  let pieceTimer = null;
  function run(keepCur){
    const query = q.value.trim();
    searchText(query);
    render(query);
    if(enabled.has('dict') && !dictData){ fetch('/keyword-dict.json', { cache: 'no-store' }).then(r => r.json()).then(d => { dictData = d; render(q.value.trim()); }).catch(() => {}); }
    if(enabled.has('pieces')){ clearTimeout(pieceTimer); pieceTimer = setTimeout(() => searchPieces(query), 300); }
  }

  function open(){ findBar.classList.add('on'); const af = activeFile(); let sel = ''; const cm = af && cmOf(af.id); if(cm){ try { sel = cm.getSelection(); } catch(_){} } if(sel && sel.length < 60) q.value = sel; q.focus(); q.select(); run(); }
  function close(){ findBar.classList.remove('on'); clearMarks(); matches = []; cur = -1; hideNote(); }

  findBar.querySelectorAll('.chip').forEach(b => b.onclick = () => { const d = b.dataset.d; if(enabled.has(d)) enabled.delete(d); else enabled.add(d); b.classList.toggle('on', enabled.has(d)); run(); });
  q.addEventListener('input', () => run());
  ciBox.addEventListener('change', () => run());
  q.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); step(e.shiftKey ? -1 : 1); } else if(e.key === 'Escape'){ e.preventDefault(); close(); } });
  findBar.querySelector('.next').onclick = () => step(1);
  findBar.querySelector('.prev').onclick = () => step(-1);
  findBar.querySelector('.x').onclick = close;

  box.addEventListener('keydown', e => { if((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && box.style.display !== 'none'){ e.preventDefault(); findBar.classList.contains('on') ? q.select() : open(); } }, true);

  const bar = box.querySelector('.sb-bar'), legend = bar && bar.querySelector('#sbLegend');
  if(bar){ const b = document.createElement('button'); b.className = 'btn'; b.id = 'sbFindBtn'; b.textContent = '🔎 поиск'; b.title = 'единый поиск с фильтрами (Ctrl+F): текст, структура, приёмы, словарь, куски';
    b.onclick = () => findBar.classList.contains('on') ? close() : open();
    if(legend) legend.after(b); else bar.appendChild(b); }

  let t = null; edsEl.addEventListener('input', () => { if(findBar.classList.contains('on')){ clearTimeout(t); t = setTimeout(() => run(true), 400); } }, true);

  window.codelabSearch = { open, close };
})();
