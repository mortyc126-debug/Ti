// «варианты»: слово-смысл → дерево вариантов прямо у курсора. Сначала код (ярко), потом описание —
// или наоборот (переключатель). ▸ раскрывает разновидности, клик по строке вставляет код вместо слова.
// Ctrl+Пробел в редакторе, строка «варианты» в автодополнении, кнопка на панели. Данные — /api/variants.
(function(){
  const sb = window.codelabSandbox;
  const box = document.getElementById('sandbox');
  const edsEl = box && box.querySelector('#sbEds');
  const bar = box && box.querySelector('.sb-bar');
  if(!sb || !edsEl || !bar) return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const activeId = () => { try { return localStorage.getItem('codelab_sb_active'); } catch(_){ return null; } };
  const edFor = id => { for(const ed of edsEl.children){ if(ed.__f && ed.__f.id === id) return ed; } return null; };
  const activeEd = () => edFor(activeId()) || edsEl.firstElementChild;
  let order = 'code'; try { order = localStorage.getItem('codelab_var_order') || 'code'; } catch(_){}

  const st = document.createElement('style');
  st.textContent = `
  .vt{position:fixed;z-index:9990;width:520px;max-width:92vw;max-height:62vh;display:flex;flex-direction:column;background:var(--bg2,#150a2b);
    border:1px solid var(--border,#3a2f55);border-radius:11px;box-shadow:0 12px 34px rgba(0,0,0,.55);overflow:hidden}
  .vt-h{display:flex;gap:6px;align-items:center;padding:7px 8px;border-bottom:1px solid var(--border,#3a2f55)}
  .vt-h input{flex:1;min-width:0;background:var(--bg,#0e0720);border:1px solid var(--border,#3a2f55);border-radius:7px;color:var(--text,#eee);font-size:13px;padding:6px 8px}
  .vt-h button{background:var(--s2,#1a1030);border:1px solid var(--border,#3a2f55);border-radius:7px;color:var(--text2,#cbc2ea);font-size:11.5px;padding:5px 8px;cursor:pointer;white-space:nowrap}
  .vt-b{overflow:auto;padding:4px 4px 8px}
  .vt-r{display:flex;align-items:flex-start;gap:4px;border-radius:7px;padding:4px 6px;cursor:pointer}
  .vt-r:hover{background:var(--s2,#1a1030)}
  .vt-r.sel{background:color-mix(in srgb,var(--name,#3dd9ff) 16%,transparent)}
  .vt-t{flex:0 0 16px;color:var(--text3,#9c90c4);text-align:center;font-size:11px;line-height:20px;cursor:pointer;user-select:none}
  .vt-t:hover{color:var(--acc,#ff2fae)}
  .vt-m{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
  .vt-m.note-first{flex-direction:column-reverse}
  .vt-c{font:13px/1.45 ui-monospace,monospace;color:var(--text,#f6f4ff);white-space:pre-wrap;word-break:break-word}
  .vt-c .k{color:var(--name,#3dd9ff)} .vt-c .v{color:var(--str,#52F2C9)}
  .vt-d{font-size:11.5px;line-height:1.4;color:var(--text3,#9c90c4)}
  .vt-d b{color:var(--text2,#cbc2ea);font-weight:600}
  .vt-p .vt-c{color:var(--text2,#cbc2ea);font-family:system-ui,sans-serif}
  .vt-kids{margin-left:14px;border-left:1px solid var(--border,#3a2f55);padding-left:4px}
  .vt-g{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--text3,#9c90c4);margin:8px 8px 2px}
  .vt-none{color:var(--text3,#9c90c4);font-size:12.5px;padding:10px}
  `;
  document.head.appendChild(st);

  let pop = null, ctx = null, seq = 0, loadTimer = null, loadController = null, pieceController = null, composing = false, selected = 0;
  function cancelLoad(){ if(loadController){ loadController.abort(); loadController = null; } }
  function cancelPiece(){ if(pieceController){ pieceController.abort(); pieceController = null; } }
  function hide(){
    clearTimeout(loadTimer); loadTimer = null; seq++;
    cancelLoad(); cancelPiece();
    if(pop){ pop.remove(); pop = null; }
    ctx = null; selected = 0;
  }
  const rows = () => pop ? [...pop.querySelectorAll('.vt-r')].filter(row => row.offsetParent !== null) : [];
  function mark(){
    const visible = rows();
    if(!visible.length){ selected = 0; return; }
    selected = Math.max(0, Math.min(selected, visible.length - 1));
    visible.forEach((row, index) => row.classList.toggle('sel', index === selected));
    visible[selected].scrollIntoView({ block: 'nearest' });
  }
  function toggle(row, open){
    const kids = row && row.nextElementSibling && row.nextElementSibling.classList.contains('vt-kids') ? row.nextElementSibling : null;
    if(!kids) return false;
    kids.hidden = open == null ? !kids.hidden : !open;
    const arrow = row.querySelector('.vt-t');
    if(arrow) arrow.textContent = kids.hidden ? '▸' : '▾';
    return true;
  }

  // слово под курсором (или выделение) + чем его заменить
  function wordCtx(){
    const ed = activeEd(); const ta = ed && ed.querySelector('textarea'); const cm = ta && ta.__cm; const lang = ed && ed.__f && ed.__f.lang || '';
    if(cm){
      let from, to, word;
      if(cm.somethingSelected()){ from = cm.getCursor('from'); to = cm.getCursor('to'); word = cm.getSelection(); }
      else { const cur = cm.getCursor(); const line = cm.getLine(cur.line); let a = cur.ch, b = cur.ch; const re = /[\wА-Яа-яЁё$-]/;
        while(a > 0 && re.test(line[a - 1])) a--; while(b < line.length && re.test(line[b])) b++;
        // «найти элемент» — смысл из нескольких слов: берём кусок строки до курсора после последнего знака кода
        const pre = line.slice(0, cur.ch).match(/([А-Яа-яЁё][А-Яа-яЁё\s]*)$/); if(pre && /\s/.test(pre[1].trim())){ a = cur.ch - pre[1].length; }
        from = { line: cur.line, ch: a }; to = { line: cur.line, ch: b }; word = line.slice(a, b); }
      const c = cm.cursorCoords(true, 'window');
      return { lang, word: word.trim(), x: c.left, y: c.bottom + 6, put: t => { cm.replaceRange(t, from, to); cm.focus(); } };
    }
    if(ta){ const v = ta.value; let a = ta.selectionStart, b = ta.selectionEnd; const re = /[\wА-Яа-яЁё$-]/;
      if(a === b){ while(a > 0 && re.test(v[a - 1])) a--; while(b < v.length && re.test(v[b])) b++; }
      const r = ta.getBoundingClientRect();
      return { lang, word: v.slice(a, b).trim(), x: r.left + 30, y: r.top + 40, put: t => { ta.value = v.slice(0, a) + t + v.slice(b); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); } };
    }
    return { lang, word: '', x: innerWidth / 2 - 260, y: 120, put: () => {} };
  }

  const paint = (code, lang) => lang === 'css'
    ? esc(code).replace(/^([\w-]+)(:\s*)(.*?)(;?)$/, '<span class="k">$1</span>$2<span class="v">$3</span>$4')
    : esc(code);

  function rowHtml(n, depth){
    const has = n.children && n.children.length;
    const desc = n.piece ? '<span class="vt-d">' + (n.label ? esc(n.label) + ' · ' : '') + (n.detail ? esc(n.detail) + ' · ' : '') + 'кусок из библиотеки</span>'
      : '<span class="vt-d">' + (n.label ? '<b>' + esc(n.label) + '</b>' + (n.note ? ' — ' : '') : '') + esc(n.note || '') + '</span>';
    return '<div class="vt-n"><div class="vt-r' + (n.piece ? ' vt-p' : '') + '" data-code="' + esc(n.code || '') + '" data-piece="' + esc(n.piece || '') + '">'
      + '<span class="vt-t">' + (has ? (depth === 0 ? '▸' : '▸') : '') + '</span>'
      + '<span class="vt-m' + (order === 'note' ? ' note-first' : '') + '"><span class="vt-c">' + (n.piece ? esc(n.note) : n.show ? esc(n.show) : paint(n.code || n.term, n.lang)) + '</span>' + desc + '</span></div>'
      + (has ? '<div class="vt-kids" hidden>' + n.children.map(c => rowHtml(c, depth + 1)).join('') + '</div>' : '') + '</div>';
  }

  async function load(q){
    if(!pop || !ctx) return;
    const my = ++seq, currentPop = pop, currentCtx = ctx;
    cancelLoad(); cancelPiece();
    const body = currentPop.querySelector('.vt-b');
    if(!q){ body.innerHTML = '<div class="vt-none">напиши, что нужно: «отступ», «найти элемент», «цикл»…</div>'; selected = 0; return; }
    body.innerHTML = '<div class="vt-none">ищу…</div>';
    const controller = new AbortController(); loadController = controller;
    const r = await fetch('/api/search/task?q=' + encodeURIComponent(q) + '&lang=' + encodeURIComponent(currentCtx.lang || '') + '&limit=60', { signal:controller.signal })
      .then(x => x.json()).catch(() => null);
    if(loadController === controller) loadController = null;
    if(my !== seq || pop !== currentPop || ctx !== currentCtx) return;
    const roots = ((r && r.roots) || []).filter(n => n.label !== 'куски из библиотеки');
    const pieces = (r && r.pieces) || [];
    const canonical = value => String(value || '').toLowerCase().replace(/^<([a-z][a-z0-9-]*)>$/, '$1');
    const targetLabels = new Map();
    for(const root of roots){
      const key = canonical(root.term);
      if(!targetLabels.has(key)) targetLabels.set(key, root.note || root.show || root.label || root.term);
    }
    for(const target of (r && r.targets) || []){
      const root = roots.find(item => canonical(item.term) === canonical(target.targetKey));
      if(root) targetLabels.set(canonical(target.targetKey), root.note || root.show || root.label || root.term);
    }
    const byLang = new Map();
    const existingTargets = new Set();
    roots.forEach(n => {
      const l = n.lang || '';
      if(!byLang.has(l)) byLang.set(l, []);
      byLang.get(l).push(n);
      existingTargets.add(l + '\\u0000' + canonical(n.term));
    });
    // Вариантов дерева может быть меньше, чем направленных целей запроса.
    // Не теряем найденные конструкции: добавляем их в обычный языковой раздел,
    // а не прячем за лимитом корней и не создаём отдельную классификацию.
    for(const target of (r && r.targets) || []){
      const l = target.rootLang || '';
      const key = l + '\\u0000' + canonical(target.rootTerm || target.targetKey);
      if(existingTargets.has(key)) continue;
      existingTargets.add(key);
      if(!byLang.has(l)) byLang.set(l, []);
      const phrase = target.phrases && target.phrases[0];
      byLang.get(l).push({
        term: target.rootTerm || target.targetKey, lang: l,
        code: target.rootTerm || target.targetKey,
        label: phrase && phrase.phrase ? 'найдено по фразе: ' + phrase.phrase : 'найдено по описанию задачи',
        note: phrase && phrase.note || '',
        children: [], score: target.score, target: true
      });
    }
    for(const piece of pieces){
      const l = piece.lang || '';
      if(!byLang.has(l)) byLang.set(l, []);
      let group = byLang.get(l).find(n => n.group && n.label === 'Фрагменты библиотеки');
      if(!group){ group = { group: true, lang: l, label: 'Фрагменты библиотеки', note: 'Результаты по смысловым фразам и содержимому библиотеки', children: [] }; byLang.get(l).push(group); }
      const related = (piece.matchedTargets || []).map(target =>
        targetLabels.get(canonical(target)) || target
      ).filter(Boolean);
      const relationNote = related.length ? 'подобрано для: ' + [...new Set(related)].join(', ') : '';
      group.children.push({
        term: piece.title, lang: l, code: '', note: piece.title, detail: piece.desc || '',
        label: [piece.group, ...(piece.sources || []), piece.contextBoost, relationNote].filter(Boolean).join(' · '),
        piece: piece.id, children: []
      });
    }
    if(!byLang.size){ body.innerHTML = '<div class="vt-none">подходящих конструкций и фрагментов не нашлось — попробуй уточнить действие или объект</div>'; selected = 0; return; }
    body.innerHTML = [...byLang.entries()].map(([l, list]) => (byLang.size > 1 ? '<div class="vt-g">' + esc(l.toUpperCase() || 'ОБЩЕЕ') + '</div>' : '') + list.map(n => rowHtml(n, 0)).join('')).join('');
    selected = 0; mark();
  }

  function open(){
    if(composing) return;
    hide(); ctx = wordCtx();
    const currentCtx = ctx;
    pop = document.createElement('div'); pop.className = 'vt';
    pop.innerHTML = '<div class="vt-h"><input placeholder="что нужно сделать…"><button class="vt-o" title="что показывать первым">' + (order === 'code' ? 'код ↑' : 'описание ↑') + '</button><button class="vt-x" title="закрыть (Esc)">×</button></div><div class="vt-b"></div>';
    document.body.appendChild(pop);
    pop.style.left = Math.max(8, Math.min(ctx.x, innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = Math.max(8, Math.min(ctx.y, innerHeight - 260)) + 'px';
    const inp = pop.querySelector('input');
    inp.value = ctx.word;
    const scheduleLoad = () => {
      clearTimeout(loadTimer);
      seq++; cancelLoad(); cancelPiece();
      loadTimer = setTimeout(() => {
        loadTimer = null;
        if(pop && ctx === currentCtx) load(inp.value.trim());
      }, 250);
    };
    inp.addEventListener('compositionstart', () => {
      composing = true; clearTimeout(loadTimer); loadTimer = null;
      seq++; cancelLoad(); cancelPiece();
    });
    inp.addEventListener('compositionend', () => {
      composing = false; scheduleLoad();
    });
    inp.oninput = () => { if(!composing) scheduleLoad(); };
    inp.onkeydown = e => {
      if(composing || e.isComposing) return;
      const visible = rows(), row = visible[selected];
      if(e.key === 'Escape'){ e.preventDefault(); hide(); }
      else if(e.key === 'ArrowDown' && visible.length){ e.preventDefault(); selected = (selected + 1) % visible.length; mark(); }
      else if(e.key === 'ArrowUp' && visible.length){ e.preventDefault(); selected = (selected - 1 + visible.length) % visible.length; mark(); }
      else if(e.key === 'ArrowRight' && row){ if(toggle(row, true)){ e.preventDefault(); mark(); } }
      else if(e.key === 'ArrowLeft' && row){
        const kids = row.nextElementSibling && row.nextElementSibling.classList.contains('vt-kids') ? row.nextElementSibling : null;
        const parentKids = row.closest('.vt-kids');
        if(kids && !kids.hidden){ e.preventDefault(); toggle(row, false); mark(); }
        else if(parentKids && parentKids.previousElementSibling){ e.preventDefault(); const parent = parentKids.previousElementSibling; toggle(parent, false); selected = rows().indexOf(parent); mark(); }
      }
      else if(e.key === 'Enter' && row){
        e.preventDefault();
        const kids = row.nextElementSibling && row.nextElementSibling.classList.contains('vt-kids') ? row.nextElementSibling : null;
        if(!row.dataset.code && !row.dataset.piece && kids){ toggle(row, true); mark(); }
        else row.click();
      }
    };
    pop.querySelector('.vt-x').onclick = hide;
    pop.querySelector('.vt-o').onclick = e => { order = order === 'code' ? 'note' : 'code'; try { localStorage.setItem('codelab_var_order', order); } catch(_){} 
      e.target.textContent = order === 'code' ? 'код ↑' : 'описание ↑'; pop.querySelectorAll('.vt-m').forEach(m => m.classList.toggle('note-first', order === 'note')); };
    pop.querySelector('.vt-b').addEventListener('click', async e => {
      const row = e.target.closest('.vt-r'); if(!row) return;
      const kids = row.nextElementSibling && row.nextElementSibling.classList.contains('vt-kids') ? row.nextElementSibling : null;
      // ▸ — раскрыть разновидности; клик по коду — вставить
      if(e.target.closest('.vt-t')){ if(kids){ toggle(row); mark(); } return; }
      const targetCtx = ctx, targetPop = pop, targetSeq = seq;
      let code = row.dataset.code;
      if(row.dataset.piece){
        cancelPiece();
        const controller = new AbortController(); pieceController = controller;
        const tp = await fetch('/api/template?id=' + encodeURIComponent(row.dataset.piece), { signal:controller.signal })
          .then(x => x.json()).catch(() => ({}));
        if(pieceController === controller) pieceController = null;
        if(ctx !== targetCtx || pop !== targetPop || seq !== targetSeq) return;
        code = tp.code != null ? tp.code : (Array.isArray(tp.lines) ? tp.lines.map(l => (l || []).map(k => k.v != null ? k.v : '').join('')).join('\n') : '');
      }
      if(code && ctx === targetCtx && pop === targetPop && seq === targetSeq){ targetCtx.put(code); hide(); }
    });
    load(ctx.word); inp.focus(); inp.select();
  }
  document.addEventListener('mousedown', e => { if(pop && !pop.contains(e.target)) hide(); });
  // Не открываем дерево посреди IME-композиции в редакторе.
  edsEl.addEventListener('compositionstart', () => { composing = true; if(pop) hide(); }, true);
  edsEl.addEventListener('compositionend', () => { composing = false; }, true);
  // Ctrl+Пробел в редакторе
  edsEl.addEventListener('keydown', e => {
    if(composing || e.isComposing) return;
    if((e.ctrlKey || e.metaKey) && e.code === 'Space'){ e.preventDefault(); e.stopPropagation(); open(); }
  }, true);
  // кнопка на панели — рядом с поиском
  const b = document.createElement('button'); b.className = 'btn'; b.id = 'sbVarBtn'; b.textContent = 'варианты';
  b.title = 'дерево вариантов для слова у курсора: «отступ» → внешний / внутренний → … (Ctrl+Пробел)';
  b.onmousedown = e => e.preventDefault();   // не уводить фокус из редактора — иначе потеряется слово под курсором
  b.onclick = open;
  const find = bar.querySelector('#sbFindBtn'); if(find) find.after(b); else bar.appendChild(b);
  window.codelabVariants = { open };
})();
