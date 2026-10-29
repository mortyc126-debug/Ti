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

  let pop = null, ctx = null, seq = 0;
  function hide(){ if(pop){ pop.remove(); pop = null; } ctx = null; }

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
    const desc = n.piece ? '<span class="vt-d">кусок из библиотеки</span>'
      : '<span class="vt-d">' + (n.label ? '<b>' + esc(n.label) + '</b>' + (n.note ? ' — ' : '') : '') + esc(n.note || '') + '</span>';
    return '<div class="vt-n"><div class="vt-r' + (n.piece ? ' vt-p' : '') + '" data-code="' + esc(n.code || '') + '" data-piece="' + esc(n.piece || '') + '">'
      + '<span class="vt-t">' + (has ? (depth === 0 ? '▸' : '▸') : '') + '</span>'
      + '<span class="vt-m' + (order === 'note' ? ' note-first' : '') + '"><span class="vt-c">' + (n.piece ? esc(n.note) : paint(n.code, n.lang)) + '</span>' + desc + '</span></div>'
      + (has ? '<div class="vt-kids" hidden>' + n.children.map(c => rowHtml(c, depth + 1)).join('') + '</div>' : '') + '</div>';
  }

  async function load(q){
    const my = ++seq; const body = pop.querySelector('.vt-b');
    if(!q){ body.innerHTML = '<div class="vt-none">напиши, что нужно: «отступ», «найти элемент», «цикл»…</div>'; return; }
    body.innerHTML = '<div class="vt-none">ищу…</div>';
    const r = await fetch('/api/variants?q=' + encodeURIComponent(q) + '&lang=' + encodeURIComponent(ctx.lang || '')).then(x => x.json()).catch(() => null);
    if(my !== seq || !pop) return;
    let roots = (r && r.roots) || [];
    // в файле на другом языке ничего — смотрим во всех языках
    if(!roots.length && ctx.lang){ const r2 = await fetch('/api/variants?q=' + encodeURIComponent(q)).then(x => x.json()).catch(() => null); if(my !== seq || !pop) return; roots = (r2 && r2.roots) || []; }
    if(!roots.length){ body.innerHTML = '<div class="vt-none">вариантов не нашлось — попробуй другое слово</div>'; return; }
    const byLang = new Map(); roots.forEach(n => { if(!byLang.has(n.lang)) byLang.set(n.lang, []); byLang.get(n.lang).push(n); });
    body.innerHTML = [...byLang.entries()].map(([l, list]) => (byLang.size > 1 ? '<div class="vt-g">' + esc(l.toUpperCase()) + '</div>' : '') + list.map(n => rowHtml(n, 0)).join('')).join('');
  }

  function open(){
    hide(); ctx = wordCtx();
    pop = document.createElement('div'); pop.className = 'vt';
    pop.innerHTML = '<div class="vt-h"><input placeholder="что нужно сделать…"><button class="vt-o" title="что показывать первым">' + (order === 'code' ? 'код ↑' : 'описание ↑') + '</button><button class="vt-x" title="закрыть (Esc)">×</button></div><div class="vt-b"></div>';
    document.body.appendChild(pop);
    pop.style.left = Math.max(8, Math.min(ctx.x, innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = Math.max(8, Math.min(ctx.y, innerHeight - 260)) + 'px';
    const inp = pop.querySelector('input'); inp.value = ctx.word;
    let t = null; inp.oninput = () => { clearTimeout(t); t = setTimeout(() => load(inp.value.trim()), 250); };
    inp.onkeydown = e => { if(e.key === 'Escape') hide(); if(e.key === 'Enter'){ const first = pop.querySelector('.vt-r'); if(first) first.click(); } };
    pop.querySelector('.vt-x').onclick = hide;
    pop.querySelector('.vt-o').onclick = e => { order = order === 'code' ? 'note' : 'code'; try { localStorage.setItem('codelab_var_order', order); } catch(_){}
      e.target.textContent = order === 'code' ? 'код ↑' : 'описание ↑'; pop.querySelectorAll('.vt-m').forEach(m => m.classList.toggle('note-first', order === 'note')); };
    pop.querySelector('.vt-b').addEventListener('click', async e => {
      const row = e.target.closest('.vt-r'); if(!row) return;
      const kids = row.nextElementSibling && row.nextElementSibling.classList.contains('vt-kids') ? row.nextElementSibling : null;
      // ▸ — раскрыть разновидности; клик по коду — вставить
      if(e.target.closest('.vt-t')){ if(kids){ kids.hidden = !kids.hidden; row.querySelector('.vt-t').textContent = kids.hidden ? '▸' : '▾'; } return; }
      let code = row.dataset.code;
      if(row.dataset.piece){ const tp = await fetch('/api/template?id=' + encodeURIComponent(row.dataset.piece)).then(x => x.json()).catch(() => ({}));
        code = tp.code != null ? tp.code : (Array.isArray(tp.lines) ? tp.lines.map(l => (l || []).map(k => k.v != null ? k.v : '').join('')).join('\n') : ''); }
      if(code && ctx){ ctx.put(code); hide(); }
    });
    load(ctx.word); inp.focus(); inp.select();
  }
  document.addEventListener('mousedown', e => { if(pop && !pop.contains(e.target)) hide(); });
  // Ctrl+Пробел в редакторе
  edsEl.addEventListener('keydown', e => { if((e.ctrlKey || e.metaKey) && e.code === 'Space'){ e.preventDefault(); e.stopPropagation(); open(); } }, true);
  // кнопка на панели — рядом с поиском
  const b = document.createElement('button'); b.className = 'btn'; b.id = 'sbVarBtn'; b.textContent = 'варианты';
  b.title = 'дерево вариантов для слова у курсора: «отступ» → внешний / внутренний → … (Ctrl+Пробел)';
  b.onmousedown = e => e.preventDefault();   // не уводить фокус из редактора — иначе потеряется слово под курсором
  b.onclick = open;
  const find = bar.querySelector('#sbFindBtn'); if(find) find.after(b); else bar.appendChild(b);
  window.codelabVariants = { open };
})();
