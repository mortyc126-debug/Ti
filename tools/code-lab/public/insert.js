// «Вставить по смыслу» (обратный процесс к пояснениям): пишешь слово/фразу в редакторе → предлагаются
// куски-код (вставить целиком) и термины синтаксиса (заменить слово), с пояснениями. Выбор подставляет в код.
// Источники: куски (/api/search), синонимы (смысл→термин) и словарь. Надстройка песочницы; после tabs.js.
(function(){
  const sb = window.codelabSandbox;
  const box = document.getElementById('sandbox');
  const edsEl = box && box.querySelector('#sbEds');
  const bar = box && box.querySelector('.sb-bar');
  if(!sb || !box || !edsEl || !bar){ return; }

  const activeId = () => { try { return localStorage.getItem('codelab_sb_active'); } catch(_){ return null; } };
  const edFor = id => { for(const ed of edsEl.children){ if(ed.__f && ed.__f.id === id) return ed; } return null; };
  const activeEd = () => edFor(activeId()) || edsEl.firstElementChild;
  const taOf = ed => ed && ed.querySelector('textarea');

  let DICT = null, PIECES = null;
  const loadDict = () => DICT ? Promise.resolve(DICT) : fetch('/keyword-dict.json', { cache: 'no-store' }).then(r => r.json()).then(d => (DICT = d || {})).catch(() => (DICT = {}));
  const loadPieces = () => PIECES ? Promise.resolve(PIECES) : fetch('/api/list').then(r => r.json()).then(l => (PIECES = l || [])).catch(() => (PIECES = []));

  const st = document.createElement('style');
  st.textContent = `
  .ins-pop{position:fixed;z-index:9999;width:360px;max-height:64vh;overflow:auto;background:var(--bg2,#150a2b);color:var(--text,#eee);
    border:1px solid var(--border,#3a2f55);border-radius:11px;box-shadow:0 10px 32px rgba(0,0,0,.55);padding:8px}
  .ins-pop .q{width:100%;box-sizing:border-box;background:var(--bg,#0e0720);color:var(--text,#eee);border:1px solid var(--border,#3a2f55);border-radius:7px;padding:6px 9px;font:13px monospace;margin-bottom:6px}
  .ins-pop .grp{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#9a93b5);margin:6px 0 2px}
  .ins-it{display:block;width:100%;text-align:left;background:transparent;border:0;color:var(--text,#eee);padding:5px 7px;border-radius:7px;cursor:pointer}
  .ins-it:hover,.ins-it.sel{background:rgba(82,242,201,.14)}
  .ins-it .t{font-size:12.5px;display:flex;gap:6px;align-items:baseline}
  .ins-it .t .lg{margin-left:auto;font-size:9px;color:var(--muted,#9a93b5);font-family:ui-monospace,monospace}
  .ins-it .d{font-size:11px;color:var(--muted,#9a93b5);line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ins-none{color:var(--muted,#9a93b5);font-size:12px;font-style:italic;padding:6px}
  `;
  document.head.appendChild(st);

  let pop = null;
  const hide = () => { if(pop){ pop.remove(); pop = null; } document.removeEventListener('mousedown', outside, true); };
  function outside(e){ if(pop && !pop.contains(e.target)) hide(); }

  // контекст правки: что заменяем и чем. CM — по выделению/слову; textarea — так же.
  function editCtx(ed){
    const ta = taOf(ed), cm = ta && ta.__cm;
    if(cm){
      let sel = cm.getSelection();
      if(sel){ return { q: sel, put: txt => { cm.replaceSelection(txt); cm.focus(); } }; }
      const w = cm.findWordAt(cm.getCursor()), word = cm.getRange(w.anchor, w.head);
      return { q: (word || '').trim(), put: txt => { cm.replaceRange(txt, w.anchor, w.head); cm.focus(); } };
    }
    if(ta){
      let a = ta.selectionStart, b = ta.selectionEnd, v = ta.value;
      if(a === b){ const re = /[\wА-Яа-яЁё$-]/; while(a > 0 && re.test(v[a - 1])) a--; while(b < v.length && re.test(v[b])) b++; }
      const q = v.slice(a, b);
      return { q: (q || '').trim(), put: txt => { ta.value = v.slice(0, a) + txt + v.slice(b); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); try { ta.setSelectionRange(a + txt.length, a + txt.length); } catch(_){} } };
    }
    return null;
  }

  // подобрать предложения по запросу q: куски (код) + термины синтаксиса (слово)
  async function suggest(q){
    const lq = q.toLowerCase().trim();
    const out = { pieces: [], terms: [] };
    if(!lq) return out;
    const d = await loadDict();
    // термины: прямое совпадение имени + «смысл→термин» через синонимы
    const seen = new Set();
    const addTerm = (term, text) => { const k = term.toLowerCase(); if(seen.has(k)) return; seen.add(k); out.terms.push({ term, text: text || '' }); };
    const scan = obj => { if(!obj) return; for(const [k, v] of Object.entries(obj)){ if(typeof v !== 'string') continue; if(k.toLowerCase().includes(lq)) addTerm(k, v); } };
    scan(d.words); ['cssProps','cssVals','htmlTags','htmlAttrs'].forEach(s => scan(d[s]));
    if(d.langs) for(const l of Object.keys(d.langs)) scan(d.langs[l]);
    if(d.synonyms){ const explOf = t => { const lt = t.toLowerCase(); if(d.words && d.words[lt]) return d.words[lt]; for(const s of ['cssProps','cssVals','htmlTags','htmlAttrs']) if(d[s] && d[s][lt]) return d[s][lt]; if(d.langs) for(const l of Object.keys(d.langs)) if(d.langs[l][lt]) return d.langs[l][lt]; return ''; };
      for(const [term, syns] of Object.entries(d.synonyms)){ if(Array.isArray(syns) && syns.some(x => String(x).toLowerCase().includes(lq))) addTerm(term, explOf(term)); } }
    out.terms = out.terms.slice(0, 10);
    // куски: поиск по библиотеке
    try { const r = await fetch('/api/search?q=' + encodeURIComponent(q) + '&limit=12').then(x => x.json());
      const list = await loadPieces(); const byId = {}; list.forEach(p => byId[p.id] = p);
      out.pieces = ((r && r.hits) || []).map(h => { const p = byId[h.id] || {}; return { id: h.id, title: p.title || h.id, lang: p.lang || '', desc: p.desc || '' }; });
    } catch(_){}
    return out;
  }

  async function insertPiece(ctx, h){
    try { const t = await fetch('/api/template?id=' + encodeURIComponent(h.id)).then(r => r.json());
      const code = t.code != null ? t.code : (Array.isArray(t.lines) ? t.lines.map(l => (l || []).map(k => k.v != null ? k.v : '').join('')).join('\n') : '');
      ctx.put(code); hide();
    } catch(_){}
  }

  async function openAt(ed){
    const ctx = editCtx(ed); if(!ctx){ return; }
    hide();
    pop = document.createElement('div'); pop.className = 'ins-pop';
    const qin = document.createElement('input'); qin.className = 'q'; qin.placeholder = 'что вставить (напр. сортировка)…'; qin.value = ctx.q || '';
    pop.appendChild(qin);
    const body = document.createElement('div'); pop.appendChild(body);
    document.body.appendChild(pop);
    // позиция у курсора/выделения
    const ta = taOf(ed), cm = ta && ta.__cm; let x = innerWidth / 2 - 180, y = 120;
    try { if(cm){ const c = cm.cursorCoords(true, 'window'); x = c.left; y = c.bottom + 6; } else if(ta){ const r = ta.getBoundingClientRect(); x = r.left + 20; y = r.top + 40; } } catch(_){}
    pop.style.left = Math.max(8, Math.min(x, innerWidth - 372)) + 'px'; pop.style.top = Math.max(8, Math.min(y, innerHeight - 320)) + 'px';
    qin.focus(); qin.select();
    let timer = null;
    const render = async () => {
      const res = await suggest(qin.value);
      body.innerHTML = '';
      if(!res.pieces.length && !res.terms.length){ body.innerHTML = '<div class="ins-none">ничего не нашлось — попробуй другое слово</div>'; return; }
      if(res.pieces.length){ body.appendChild(grp('код — вставить кусок'));
        res.pieces.forEach(h => body.appendChild(item(h.title, h.lang, h.desc, () => insertPiece(ctx, h)))); }
      if(res.terms.length){ body.appendChild(grp('синтаксис — заменить слово'));
        res.terms.forEach(t => body.appendChild(item(t.term, '', t.text, () => { ctx.put(t.term); hide(); }))); }
    };
    function grp(t){ const d = document.createElement('div'); d.className = 'grp'; d.textContent = t; return d; }
    function item(title, lang, desc, onPick){ const b = document.createElement('button'); b.className = 'ins-it';
      const t = document.createElement('div'); t.className = 't'; const nm = document.createElement('span'); nm.textContent = title; nm.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; t.appendChild(nm);
      if(lang){ const lg = document.createElement('span'); lg.className = 'lg'; lg.textContent = String(lang).toUpperCase(); t.appendChild(lg); }
      b.appendChild(t); if(desc){ const d = document.createElement('div'); d.className = 'd'; d.textContent = desc; b.appendChild(d); }
      b.onclick = onPick; return b; }
    qin.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 220); });
    qin.addEventListener('keydown', e => { if(e.key === 'Escape'){ e.preventDefault(); hide(); } });
    render();
    setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  }

  const b = document.createElement('button'); b.className = 'btn'; b.id = 'sbInsBtn'; b.textContent = '✨ вставить';
  b.title = 'вставить по смыслу: выдели слово/фразу (или поставь курсор) и выбери кусок-код или термин синтаксиса';
  b.onclick = () => openAt(activeEd());
  const legend = bar.querySelector('#sbLegend'); if(legend) legend.after(b); else bar.appendChild(b);
  // Ctrl+Space в редакторе — быстрый вызов
  edsEl.addEventListener('keydown', e => { if((e.ctrlKey || e.metaKey) && e.code === 'Space'){ e.preventDefault(); const ed = e.target.closest && e.target.closest('.sb-ed'); if(ed) openAt(ed); } }, true);
})();
