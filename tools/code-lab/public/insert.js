// Живое автодополнение по смыслу: пишешь слово в редакторе — всплывает список подсказок у курсора.
// Термины синтаксиса (словарь + смысл→термин через синонимы) заменяют слово; куски — вставляют код.
// Стрелки ↑↓ выбирают, Enter/Tab вставляет, Esc прячет. Галочка «автодополнение» в панели (по умолчанию вкл).
// Надстройка песочницы; после tabs.js. Подключён на constructor.html.
(function(){
  const sb = window.codelabSandbox;
  const box = document.getElementById('sandbox');
  const edsEl = box && box.querySelector('#sbEds');
  const bar = box && box.querySelector('.sb-bar');
  if(!sb || !box || !edsEl || !bar){ return; }

  const taOf = ed => ed && ed.querySelector('textarea');
  let DICT = null, PIECES = null;
  const loadDict = () => DICT ? Promise.resolve(DICT) : fetch('/keyword-dict.json', { cache: 'no-store' }).then(r => r.json()).then(d => (DICT = d || {})).catch(() => (DICT = {}));
  // задачи (деревья решений) — по названию и синонимам; выбор открывает окно «🧭 задачи» на этой задаче
  let TASKS = null;
  const loadTasks = () => TASKS ? Promise.resolve(TASKS) : fetch('/api/tasks/list').then(r => r.json()).then(l => (TASKS = l || [])).catch(() => (TASKS = []));
  setInterval(() => { TASKS = null; }, 60000);   // новые задачи со страницы «Задачи» подхватываются без перезагрузки
  function tasksFor(q){
    const lq = q.toLowerCase().replace(/ё/g, 'е'); if(lq.length < 3 || !TASKS || !window.codelabTaskPanel) return [];
    const hit = t => [t.title].concat(t.aliases || []).some(x => String(x).toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}_]+/u).some(w => w.startsWith(lq)));
    return TASKS.filter(hit).slice(0, 3).map(t => ({ type: 'task', id: t.id, label: t.title, desc: 'вопросы → код' }));
  }
  const loadPieces = () => PIECES ? Promise.resolve(PIECES) : fetch('/api/list').then(r => r.json()).then(l => (PIECES = l || [])).catch(() => (PIECES = []));

  const st = document.createElement('style');
  st.textContent = `
  .ac-pop{position:fixed;z-index:9999;min-width:220px;max-width:420px;max-height:50vh;overflow:auto;background:var(--bg2,#150a2b);color:var(--text,#eee);
    border:1px solid var(--border,#3a2f55);border-radius:9px;box-shadow:0 8px 26px rgba(0,0,0,.5);padding:4px;font-size:12.5px}
  .ac-it{display:flex;gap:7px;align-items:baseline;padding:4px 7px;border-radius:6px;cursor:pointer;white-space:nowrap}
  .ac-it.sel{background:rgba(82,242,201,.18)}
  .ac-it .k{font-family:ui-monospace,monospace;flex:0 0 auto}
  .ac-it .tag{font-size:9px;color:#06231c;background:var(--acc,#52F2C9);border-radius:4px;padding:0 4px;flex:0 0 auto}
  .ac-it .tag.code{background:var(--name,#3dd9ff)}
  .ac-it .tag.task{background:var(--kw,#b45cff);color:#fff}
  .ac-it .d{color:var(--muted,#9a93b5);overflow:hidden;text-overflow:ellipsis;font-size:11px}
  `;
  document.head.appendChild(st);

  // ── состояние ──
  let acOn = true; try { acOn = localStorage.getItem('codelab_ac') !== 'off'; } catch(_){}
  let pop = null, items = [], sel = 0, seq = 0, timer = null, curCtx = null;

  function hide(){ if(pop){ pop.remove(); pop = null; } items = []; sel = 0; }

  // контекст: слово вокруг курсора + куда/как заменить + координаты курсора
  function wordCtx(ed){
    const ta = taOf(ed), cm = ta && ta.__cm;
    if(cm){
      if(cm.somethingSelected()) return null;              // при выделении не мешаем
      const cur = cm.getCursor(), w = cm.findWordAt(cur), word = cm.getRange(w.anchor, w.head);
      if(cur.ch !== w.head.ch) return null;                // курсор не в конце слова — не дополняем
      const c = cm.cursorCoords(true, 'window');
      return { word: (word || '').trim(), x: c.left, y: c.bottom + 4, put: txt => { cm.replaceRange(txt, w.anchor, w.head); cm.focus(); } };
    }
    if(ta){
      const v = ta.value, p = ta.selectionStart; if(p !== ta.selectionEnd) return null;
      const re = /[\wА-Яа-яЁё$-]/; let a = p, b = p; while(a > 0 && re.test(v[a - 1])) a--; while(b < v.length && re.test(v[b])) b++;
      if(b !== p) return null;                             // курсор не в конце слова
      const r = ta.getBoundingClientRect();
      return { word: v.slice(a, b).trim(), x: r.left + 24, y: r.top + 40, put: txt => { ta.value = v.slice(0, a) + txt + v.slice(b); ta.dispatchEvent(new Event('input', { bubbles: true })); try { ta.setSelectionRange(a + txt.length, a + txt.length); } catch(_){} ta.focus(); } };
    }
    return null;
  }

  // термины по началу слова (мгновенно, из закэшированного словаря): префикс + смысл через синонимы
  function termsFrom(q, d){
    const lq = q.toLowerCase(); const out = []; const seen = new Set();
    const isCode = t => !/\s/.test(t) && !/[А-Яа-яЁё]/.test(t);   // в код вставляем только код-токены, не фразы
    const addTerm = (term, text) => { const k = term.toLowerCase(); if(seen.has(k) || k === lq || !isCode(term)) return; seen.add(k); out.push({ type: 'term', label: term, desc: text || '' }); };
    const scanPrefix = o => { if(o) for(const k of Object.keys(o)){ if(k.toLowerCase().startsWith(lq)) addTerm(k, o[k]); } };
    const l = (curCtx && curCtx.lang || '').toLowerCase();
    if(d.langs && d.langs[l]) scanPrefix(d.langs[l]);
    scanPrefix(d.words); ['cssProps','cssVals','htmlTags','htmlAttrs'].forEach(s => scanPrefix(d[s]));
    if(d.langs) for(const k of Object.keys(d.langs)) if(k !== l) scanPrefix(d.langs[k]);
    if(d.synonyms && out.length < 8){ const explOf = t => { const lt = t.toLowerCase(); if(d.words && d.words[lt]) return d.words[lt]; for(const s of ['cssProps','cssVals','htmlTags','htmlAttrs']) if(d[s] && d[s][lt]) return d[s][lt]; if(d.langs) for(const k of Object.keys(d.langs)) if(d.langs[k][lt]) return d.langs[k][lt]; return ''; };
      for(const [term, syns] of Object.entries(d.synonyms)){ if(Array.isArray(syns) && syns.some(x => String(x).toLowerCase().startsWith(lq))) addTerm(term, explOf(term)); } }
    return out.slice(0, 7);
  }
  // куски-код из библиотеки (отдельно, чтобы не ждать сеть ради показа слов)
  async function piecesFor(q){
    try { const r = await fetch('/api/search?q=' + encodeURIComponent(q) + '&limit=6&lang=' + encodeURIComponent((curCtx && curCtx.lang) || '')).then(x => x.json());
      const list = await loadPieces(); const byId = {}; list.forEach(p => byId[p.id] = p);
      return ((r && r.hits) || []).slice(0, 5).map(h => { const p = byId[h.id] || {}; return { type: 'piece', id: h.id, label: p.title || h.id, desc: (p.lang || '').toUpperCase() }; });
    } catch(_){ return []; }
  }

  async function accept(it){
    if(!curCtx) return;
    if(it.type === 'term'){ curCtx.put(it.label); hide(); return; }
    if(it.type === 'task'){ curCtx.put(''); hide(); if(window.codelabTaskPanel) window.codelabTaskPanel.openTask(it.id); return; }   // набранное было поиском, а не кодом
    try { const t = await fetch('/api/template?id=' + encodeURIComponent(it.id)).then(r => r.json());
      const code = t.code != null ? t.code : (Array.isArray(t.lines) ? t.lines.map(l => (l || []).map(k => k.v != null ? k.v : '').join('')).join('\n') : '');
      curCtx.put(code);
    } catch(_){}
    hide();
  }

  function renderPop(){
    if(!pop){ pop = document.createElement('div'); pop.className = 'ac-pop'; document.body.appendChild(pop); }
    pop.innerHTML = '';
    items.forEach((it, i) => {
      const row = document.createElement('div'); row.className = 'ac-it' + (i === sel ? ' sel' : '');
      const tag = document.createElement('span'); tag.className = 'tag' + (it.type === 'piece' ? ' code' : it.type === 'task' ? ' task' : ''); tag.textContent = it.type === 'piece' ? 'код' : it.type === 'task' ? 'задача' : 'слово'; row.appendChild(tag);
      const k = document.createElement('span'); k.className = 'k'; k.textContent = it.label; row.appendChild(k);
      if(it.desc){ const d = document.createElement('span'); d.className = 'd'; d.textContent = it.desc; row.appendChild(d); }
      row.addEventListener('mousedown', e => { e.preventDefault(); accept(it); });
      pop.appendChild(row);
    });
    pop.style.left = Math.max(8, Math.min(curCtx.x, innerWidth - pop.offsetWidth - 12)) + 'px';
    pop.style.top = Math.max(8, Math.min(curCtx.y, innerHeight - pop.offsetHeight - 12)) + 'px';
  }

  function trigger(ed){
    const ctx = wordCtx(ed); if(!ctx || ctx.word.length < 2){ hide(); return; }
    ctx.lang = ed.__f && ed.__f.lang; curCtx = ctx;
    const my = ++seq; loadTasks();
    const dp = window.codelabKwDict ? window.codelabKwDict(ctx.lang || '') : loadDict();
    dp.then(d => {
      if(my !== seq) return;
      const terms = tasksFor(ctx.word).concat(termsFrom(ctx.word, d));   // задачи и слова — сразу (задачи из кэша)
      items = terms; sel = 0; if(items.length) renderPop(); else hide();
      piecesFor(ctx.word).then(pc => { if(my !== seq || !pc.length) return; items = terms.concat(pc); if(sel >= items.length) sel = 0; renderPop(); });
    });
  }

  // набор в редакторе → подсказки (с задержкой); служебные клавиши не триггерят
  edsEl.addEventListener('keyup', e => {
    if(!acOn) return;
    if(e.ctrlKey || e.metaKey || e.altKey) return;
    if(['ArrowDown','ArrowUp','Enter','Tab','Escape','ArrowLeft','ArrowRight','Home','End','Shift','Control','Alt','Meta'].includes(e.key)) return;
    const ed = e.target.closest && e.target.closest('.sb-ed'); if(!ed){ hide(); return; }
    clearTimeout(timer); timer = setTimeout(() => trigger(ed), 180);
  }, true);
  // навигация по списку — перехватываем только когда список открыт
  edsEl.addEventListener('keydown', e => {
    if(!pop || !items.length) return;
    if(e.key === 'ArrowDown'){ e.preventDefault(); sel = (sel + 1) % items.length; renderPop(); }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); sel = (sel - 1 + items.length) % items.length; renderPop(); }
    else if(e.key === 'Enter' || e.key === 'Tab'){ e.preventDefault(); accept(items[sel]); }
    else if(e.key === 'Escape'){ e.preventDefault(); hide(); }
  }, true);
  edsEl.addEventListener('scroll', hide, true);
  document.addEventListener('mousedown', e => { if(pop && !pop.contains(e.target)) hide(); }, true);

  // галочка в панели (по умолчанию включено)
  const lab = document.createElement('label'); lab.className = 'sb-live'; lab.title = 'подсказывать куски и синтаксис по мере набора';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'sbAc'; cb.checked = acOn;
  cb.onchange = () => { acOn = cb.checked; try { localStorage.setItem('codelab_ac', acOn ? 'on' : 'off'); } catch(_){} if(!acOn) hide(); };
  lab.appendChild(cb); lab.appendChild(document.createTextNode(' ✨ автодополнение'));
  const legend = bar.querySelector('#sbLegend'); if(legend) legend.after(lab); else bar.appendChild(lab);
})();
