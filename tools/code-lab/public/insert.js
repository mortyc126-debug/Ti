// Подсказки в редакторе — одно окошко: набираешь слово («отступ», «quer», «найти элемент») — у курсора дерево
// вариантов: сначала код (ярко), потом смысл; ▸ раскрывает разновидности. ↑↓ — выбор, → / ← — раскрыть/свернуть,
// Enter/Tab — вставить вместо слова, Esc — закрыть. Ctrl+Пробел — открыть для слова под курсором.
// Деревья — /api/variants (синонимы → термины → разновидности); нет дерева — слова словаря по началу.
// Галочка «✨ подсказки» в панели (по умолчанию вкл). Надстройка песочницы; после tabs.js.
(function(){
  const sb = window.codelabSandbox;
  const box = document.getElementById('sandbox');
  const edsEl = box && box.querySelector('#sbEds');
  const bar = box && box.querySelector('.sb-bar');
  if(!sb || !box || !edsEl || !bar){ return; }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const taOf = ed => ed && ed.querySelector('textarea');
  const activeId = () => { try { return localStorage.getItem('codelab_sb_active'); } catch(_){ return null; } };
  const edFor = id => { for(const ed of edsEl.children){ if(ed.__f && ed.__f.id === id) return ed; } return null; };
  let order = 'code'; try { order = localStorage.getItem('codelab_var_order') || 'code'; } catch(_){}

  const st = document.createElement('style');
  st.textContent = `
  .ac-pop{position:fixed;z-index:9999;width:480px;max-width:92vw;max-height:56vh;display:flex;flex-direction:column;background:var(--bg2,#150a2b);color:var(--text,#eee);
    border:1px solid var(--border,#3a2f55);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.55);overflow:hidden}
  .ac-b{overflow:auto;padding:3px}
  .ac-r{display:flex;align-items:flex-start;gap:3px;border-radius:7px;padding:3px 6px;cursor:pointer}
  .ac-r.sel{background:color-mix(in srgb,var(--name,#3dd9ff) 16%,transparent)}
  .ac-r:hover{background:var(--s2,#1a1030)}
  .ac-t{flex:0 0 15px;color:var(--text3,#9c90c4);text-align:center;font-size:11px;line-height:20px;user-select:none}
  .ac-t:hover{color:var(--acc,#ff2fae)}
  .ac-m{flex:1;min-width:0;display:flex;flex-direction:column}
  .ac-m.nf{flex-direction:column-reverse}
  .ac-c{font:13px/1.45 ui-monospace,monospace;color:var(--text,#f6f4ff);white-space:pre-wrap;word-break:break-word}
  .ac-c .k{color:var(--name,#3dd9ff)} .ac-c .v{color:var(--str,#52F2C9)}
  .ac-d{font-size:11.5px;line-height:1.35;color:var(--text3,#9c90c4)}
  .ac-d b{color:var(--text2,#cbc2ea);font-weight:600}
  .ac-p .ac-c{color:var(--text2,#cbc2ea);font-family:system-ui,sans-serif}
  .ac-kids{margin-left:13px;border-left:1px solid var(--border,#3a2f55);padding-left:3px}
  .ac-g{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--text3,#9c90c4);margin:6px 7px 1px}
  .ac-f{display:flex;gap:8px;align-items:center;padding:4px 8px;border-top:1px solid var(--border,#3a2f55);font-size:10.5px;color:var(--text3,#9c90c4)}
  .ac-f button{margin-left:auto;background:none;border:1px solid var(--border,#3a2f55);border-radius:6px;color:var(--text2,#cbc2ea);font-size:10.5px;padding:2px 6px;cursor:pointer}
  `;
  document.head.appendChild(st);

  let acOn = true; try { acOn = localStorage.getItem('codelab_ac') !== 'off'; } catch(_){}
  let pop = null, ctx = null, seq = 0, timer = null, sel = 0;
  function hide(){ if(pop){ pop.remove(); pop = null; } ctx = null; }

  // слово (или русская фраза) у курсора и как его заменить
  function wordCtx(ed, force){
    const ta = taOf(ed), cm = ta && ta.__cm; const lang = (ed && ed.__f && ed.__f.lang) || '';
    if(cm){
      if(cm.somethingSelected()){ if(!force) return null; const from = cm.getCursor('from'), to = cm.getCursor('to'); const c = cm.cursorCoords(true, 'window');
        return { lang, word: cm.getSelection().trim(), x: c.left, y: c.bottom + 4, put: t => { cm.replaceRange(t, from, to); cm.focus(); } }; }
      const cur = cm.getCursor(), line = cm.getLine(cur.line); const re = /[\wА-Яа-яЁё$.-]/;
      let a = cur.ch; while(a > 0 && re.test(line[a - 1])) a--;
      if(!force && cur.ch < line.length && re.test(line[cur.ch])) return null;   // курсор посреди слова — не мешаем
      // «найти элемент» — смысл из нескольких русских слов подряд
      const ph = line.slice(0, cur.ch).match(/([А-Яа-яЁё]+(?:\s+[А-Яа-яЁё]+){1,3})$/); if(ph) a = cur.ch - ph[1].length;
      const from = { line: cur.line, ch: a }, to = { line: cur.line, ch: cur.ch }; const c = cm.cursorCoords(true, 'window');
      return { lang, word: line.slice(a, cur.ch).replace(/^\.+/, '').trim(), x: c.left, y: c.bottom + 4, put: t => { cm.replaceRange(t, from, to); cm.focus(); } };
    }
    if(ta){ const v = ta.value, p = ta.selectionStart; const re = /[\wА-Яа-яЁё$.-]/; let a = p; while(a > 0 && re.test(v[a - 1])) a--;
      const r = ta.getBoundingClientRect();
      return { lang, word: v.slice(a, p).trim(), x: r.left + 24, y: r.top + 40, put: t => { ta.value = v.slice(0, a) + t + v.slice(p); ta.dispatchEvent(new Event('input', { bubbles: true })); try { ta.setSelectionRange(a + t.length, a + t.length); } catch(_){} ta.focus(); } };
    }
    return null;
  }

  const paint = (code, lang) => lang === 'css' ? esc(code).replace(/^([\w-]+)(:\s*)(.*?)(;?)$/, '<span class="k">$1</span>$2<span class="v">$3</span>$4') : esc(code);
  function rowHtml(n){
    const has = n.children && n.children.length;
    const desc = n.piece ? 'кусок из библиотеки' : (n.label ? '<b>' + esc(n.label) + '</b>' + (n.note ? ' — ' : '') : '') + esc(n.note || '');
    return '<div class="ac-n"><div class="ac-r' + (n.piece ? ' ac-p' : '') + '" data-code="' + esc(n.code || '') + '" data-piece="' + esc(n.piece || '') + '">'
      + '<span class="ac-t">' + (has ? '▸' : '') + '</span>'
      + '<span class="ac-m' + (order === 'note' ? ' nf' : '') + '"><span class="ac-c">' + (n.piece ? esc(n.note) : paint(n.code, n.lang)) + '</span>'
      + (desc ? '<span class="ac-d">' + desc + '</span>' : '') + '</span></div>'
      + (has ? '<div class="ac-kids" hidden>' + n.children.map(rowHtml).join('') + '</div>' : '') + '</div>';
  }
  // запасной путь: слова словаря по началу («quer» → querySelector), если дерева нет
  function flatFallback(word, d, lang){
    const lq = word.toLowerCase(); const out = []; const seen = new Set();
    const scan = o => { if(o) for(const [k, v] of Object.entries(o)){ if(out.length >= 8) return; if(k.startsWith(lq) && k !== lq && !/[\sа-яё]/i.test(k) && !seen.has(k)){ seen.add(k); out.push({ code: k, note: String(v || '').replace(/^[^—]{1,40}—\s*/, ''), lang, children: [] }); } } };
    if(d.langs && d.langs[lang]) scan(d.langs[lang]); scan(d.words);
    return out;
  }

  const rows = () => pop ? [...pop.querySelectorAll('.ac-r')].filter(r => r.offsetParent !== null) : [];
  function mark(){ const rs = rows(); if(!rs.length) return; sel = Math.max(0, Math.min(sel, rs.length - 1)); rs.forEach((r, i) => r.classList.toggle('sel', i === sel)); rs[sel].scrollIntoView({ block: 'nearest' }); }
  function toggle(row, open){ const kids = row.nextElementSibling && row.nextElementSibling.classList.contains('ac-kids') ? row.nextElementSibling : null; if(!kids) return false;
    kids.hidden = open == null ? !kids.hidden : !open; row.querySelector('.ac-t').textContent = kids.hidden ? '▸' : '▾'; return true; }
  async function accept(row){
    if(!row || !ctx) return;
    let code = row.dataset.code;
    if(row.dataset.piece){ const t = await fetch('/api/template?id=' + encodeURIComponent(row.dataset.piece)).then(r => r.json()).catch(() => ({}));
      code = t.code != null ? t.code : (Array.isArray(t.lines) ? t.lines.map(l => (l || []).map(k => k.v != null ? k.v : '').join('')).join('\n') : ''); }
    if(code) ctx.put(code); hide();
  }

  async function show(ed, force){
    const c = wordCtx(ed, force); if(!c || (!force && c.word.length < 2)){ hide(); return; }
    const my = ++seq;
    let roots = [];
    if(c.word){ const r = await fetch('/api/variants?q=' + encodeURIComponent(c.word) + '&lang=' + encodeURIComponent(c.lang)).then(x => x.json()).catch(() => null); roots = (r && r.roots) || []; }
    if(my !== seq) return;
    if(!roots.length && c.word && /^[\w$.-]+$/.test(c.word)){ const d = await (window.codelabKwDict ? window.codelabKwDict(c.lang) : Promise.resolve({})); if(my !== seq) return; roots = flatFallback(c.word, d || {}, c.lang); }
    if(!roots.length){ if(force){ ctx = c; render(c, [], true); } else hide(); return; }
    ctx = c; render(c, roots);
  }
  function render(c, roots, empty){
    if(!pop){ pop = document.createElement('div'); pop.className = 'ac-pop'; document.body.appendChild(pop);
      pop.addEventListener('mousedown', e => e.preventDefault());   // не уводить фокус из редактора
      pop.addEventListener('click', e => { const row = e.target.closest('.ac-r'); if(!row) return; if(e.target.closest('.ac-t')){ toggle(row); return; } accept(row); });
    }
    const byLang = new Map(); roots.forEach(n => { const l = n.lang || ''; if(!byLang.has(l)) byLang.set(l, []); byLang.get(l).push(n); });
    pop.innerHTML = '<div class="ac-b">' + (empty ? '<div class="ac-d" style="padding:8px">для «' + esc(c.word) + '» вариантов нет — напиши смысл: «отступ», «цикл», «найти элемент»</div>'
      : [...byLang.entries()].map(([l, list]) => (byLang.size > 1 ? '<div class="ac-g">' + esc(l.toUpperCase()) + '</div>' : '') + list.map(rowHtml).join('')).join(''))
      + '</div><div class="ac-f">↑↓ выбрать · → раскрыть · Enter вставить · Esc<button title="что показывать первым">' + (order === 'code' ? 'код ↑' : 'смысл ↑') + '</button></div>';
    pop.querySelector('.ac-f button').onclick = e => { order = order === 'code' ? 'note' : 'code'; try { localStorage.setItem('codelab_var_order', order); } catch(_){}
      e.target.textContent = order === 'code' ? 'код ↑' : 'смысл ↑'; pop.querySelectorAll('.ac-m').forEach(m => m.classList.toggle('nf', order === 'note')); };
    sel = 0; mark();
    pop.style.left = Math.max(8, Math.min(c.x, innerWidth - pop.offsetWidth - 10)) + 'px';
    const below = c.y + pop.offsetHeight < innerHeight - 8;
    pop.style.top = (below ? c.y : Math.max(8, c.y - pop.offsetHeight - 28)) + 'px';
  }

  // набор → подсказки (с задержкой); служебные клавиши не триггерят
  edsEl.addEventListener('keyup', e => {
    if(!acOn || e.ctrlKey || e.metaKey || e.altKey) return;
    if(['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Enter','Tab','Escape','Home','End','Shift','Control','Alt','Meta','PageUp','PageDown'].includes(e.key)) return;
    const ed = e.target.closest && e.target.closest('.sb-ed'); if(!ed){ hide(); return; }
    clearTimeout(timer); timer = setTimeout(() => show(ed, false), 200);
  }, true);
  edsEl.addEventListener('keydown', e => {
    if((e.ctrlKey || e.metaKey) && e.code === 'Space'){ e.preventDefault(); e.stopPropagation(); const ed = e.target.closest && e.target.closest('.sb-ed'); if(ed) show(ed, true); return; }
    if(!pop) return;
    const rs = rows();
    if(e.key === 'ArrowDown'){ e.preventDefault(); sel = (sel + 1) % Math.max(1, rs.length); mark(); }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); sel = (sel - 1 + rs.length) % Math.max(1, rs.length); mark(); }
    else if(e.key === 'ArrowRight' && rs[sel] && rs[sel].nextElementSibling && rs[sel].nextElementSibling.classList.contains('ac-kids')){ e.preventDefault(); toggle(rs[sel], true); mark(); }
    else if(e.key === 'ArrowLeft' && rs[sel]){ const own = rs[sel]; const parentKids = own.closest('.ac-kids');
      if(own.nextElementSibling && own.nextElementSibling.classList.contains('ac-kids') && !own.nextElementSibling.hidden){ e.preventDefault(); toggle(own, false); mark(); }
      else if(parentKids){ e.preventDefault(); const pr = parentKids.previousElementSibling; toggle(pr, false); sel = rows().indexOf(pr); mark(); } }
    else if(e.key === 'Enter' || e.key === 'Tab'){ if(rs[sel]){ e.preventDefault(); accept(rs[sel]); } }
    else if(e.key === 'Escape'){ e.preventDefault(); hide(); }
  }, true);
  edsEl.addEventListener('scroll', hide, true);
  document.addEventListener('mousedown', e => { if(pop && !pop.contains(e.target)) hide(); }, true);

  // галочка — в меню «⚙ Подсказки» (sb-toolbar.js)
  const lab = document.createElement('label'); lab.className = 'sb-live'; lab.title = 'подсказки-деревья по мере набора (Ctrl+Пробел — всегда)';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'sbAc'; cb.checked = acOn;
  cb.onchange = () => { acOn = cb.checked; try { localStorage.setItem('codelab_ac', acOn ? 'on' : 'off'); } catch(_){} if(!acOn) hide(); };
  lab.appendChild(cb); lab.appendChild(document.createTextNode(' ✨ подсказки при наборе'));
  bar.appendChild(lab);
  window.codelabVariants = { open: () => { const ed = edFor(activeId()) || edsEl.firstElementChild; if(ed) show(ed, true); } };
})();
