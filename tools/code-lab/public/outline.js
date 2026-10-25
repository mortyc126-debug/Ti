// «🗂 структура»: оглавление активного файла — функции, классы, константы, методы и
// смысловые секции-комментарии (баннеры «// ── Имя ──»). Фильтр + прыжок к месту.
// Для навигации по большим файлам: разбор эффективный (префиксные массивы глубины и строк).
// Надстройка над window.codelabSandbox; левая панель в песочнице.
(function(){
  const sb = window.codelabSandbox;
  const box = document.getElementById('sandbox');
  const edsEl = box && box.querySelector('#sbEds');
  const bar = box && box.querySelector('.sb-bar');
  if(!sb || !box || !edsEl || !bar){ return; }

  const KW = new Set('if else for while do switch case catch return function class new typeof instanceof in of'.split(' '));
  const activeId = () => { try { return localStorage.getItem('codelab_sb_active'); } catch(_){ return null; } };
  const activeFile = () => { const fs = sb.getFiles(); return fs.find(f => f.id === activeId()) || fs[0] || null; };
  const edFor = id => { for(const ed of edsEl.children){ if(ed.__f && ed.__f.id === id) return ed; } return null; };
  const taFor = id => { const ed = edFor(id); return ed ? ed.querySelector('textarea') : null; };

  // гасим строки/комментарии → для подсчёта глубины и поиска объявлений (но НЕ для секций — те из исходных строк)
  function blank(code){
    let out = '', i = 0, n = code.length;
    while(i < n){ const c = code[i], two = code.slice(i, i + 2);
      if(two === '//'){ let j = i; while(j < n && code[j] !== '\n') j++; out += ' '.repeat(j - i); i = j; continue; }
      if(two === '/*'){ let j = i + 2; while(j < n && code.slice(j, j + 2) !== '*/') j++; j = Math.min(n, j + 2); out += ' '.repeat(j - i); i = j; continue; }
      if(c === '"' || c === "'" || c === '`'){ let j = i + 1; while(j < n && code[j] !== c){ if(code[j] === '\\') j++; j++; } j = Math.min(n, j + 1); out += ' '.repeat(j - i); i = j; continue; }
      out += c; i++; }
    return out;
  }

  // разбор в оглавление: O(n) префиксные массивы, чтобы не тормозило на больших файлах
  function parse(code, lang){
    const s = blank(code), n = code.length;
    const depth = new Int32Array(n + 1); let d = 0;           // глубина скобок в каждой позиции
    const starts = [0];                                       // смещения начала строк
    for(let i = 0; i < n; i++){ const c = s[i]; if(c === '{' || c === '(' || c === '[') d++; else if(c === '}' || c === ')' || c === ']') d = d > 0 ? d - 1 : 0; depth[i + 1] = d; if(code[i] === '\n') starts.push(i + 1); }
    const lineOf = off => { let lo = 0, hi = starts.length - 1; while(lo < hi){ const m = (lo + hi + 1) >> 1; if(starts[m] <= off) lo = m; else hi = m - 1; } return lo + 1; };
    const items = [];
    const push = (kind, name, off) => items.push({ kind, name, off, line: lineOf(off), depth: depth[off] });

    // секции-баннеры из ИСХОДНЫХ строк: // ── Имя ──, # === Имя ===, /* ── Имя ── */ и т.п.
    const bannerMid = /^(?:\/\/+|#+|\/\*+|--|;;+)[\s*]*[─—=~*#.\-]{2,}\s*([^\n─—=~*#]+?)\s*[─—=~*#.\-]{2,}.*$/;
    const bannerEnd = /^(?:\/\/+|#+)[\s*]*[─—=]{2,}\s*([^\n─—=]+?)\s*$/;
    const lines = code.split('\n');
    lines.forEach((raw, i) => { const t = raw.trim(); let m = t.match(bannerMid) || t.match(bannerEnd);
      if(m && m[1] && m[1].replace(/[\s─—=~*#.\-]/g, '').length >= 2) items.push({ kind: 'section', name: m[1].trim(), off: starts[i], line: i + 1, depth: 0 }); });

    let mm;
    const reV = /(?:^|[;{}\n])[ \t]*(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
    while((mm = reV.exec(s))){ const o = mm.index + mm[0].indexOf(mm[2]); push(mm[1], mm[2], o); }
    const reF = /(?:^|[;{}\n])[ \t]*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
    while((mm = reF.exec(s))){ const o = mm.index + mm[0].indexOf(mm[1]); push('function', mm[1], o); }
    const reC = /(?:^|[;{}\n])[ \t]*class\s+([A-Za-z_$][\w$]*)/g;
    while((mm = reC.exec(s))){ const o = mm.index + mm[0].indexOf(mm[1]); push('class', mm[1], o); }
    // методы/объектные функции: Имя(args) { на глубине ≥1
    const reM = /(?:^|[;{}\n,])[ \t]*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
    while((mm = reM.exec(s))){ const o = mm.index + mm[0].indexOf(mm[1]); if(depth[o] >= 1 && !KW.has(mm[1])) push('method', mm[1], o); }
    if((lang || '') === 'python'){
      const reD = /(?:^|\n)[ \t]*def\s+([A-Za-z_]\w*)/g; while((mm = reD.exec(s))){ const o = mm.index + mm[0].indexOf(mm[1]); push('function', mm[1], o); }
      const reP = /(?:^|\n)[ \t]*class\s+([A-Za-z_]\w*)/g; while((mm = reP.exec(s))){ const o = mm.index + mm[0].indexOf(mm[1]); push('class', mm[1], o); }
    }
    const seen = new Set();
    return items.filter(x => { const k = x.off + '|' + x.kind + '|' + x.name; if(seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.off - b.off);
  }

  // ── стили ──
  const st = document.createElement('style');
  st.textContent = `
  .sb-outline{flex:0 0 240px;max-width:44vw;min-height:0;display:none;flex-direction:column;gap:6px;margin-right:8px;
    background:var(--bg2,#150a2b);border:1px solid var(--border,#3a2f55);border-radius:10px;padding:8px;overflow:hidden}
  .sb-outline.on{display:flex}
  @media(max-width:1000px){.sb-outline{flex-basis:auto;max-width:none;margin:0 0 8px}}
  .sb-outline .oh{display:flex;align-items:center;gap:6px}
  .sb-outline .oh b{flex:1;font-size:12.5px}
  .sb-outline .oh button{background:none;border:0;color:var(--text2,#cbc2ea);cursor:pointer;font-size:14px;padding:2px 5px;border-radius:5px}
  .sb-outline .oh button:hover{background:rgba(255,255,255,.08)}
  .sb-outline input.of{width:100%;box-sizing:border-box;background:var(--bg,#0e0720);color:var(--text,#eee);border:1px solid var(--border,#3a2f55);border-radius:6px;padding:4px 8px;font:12px system-ui,sans-serif}
  .sb-outline .olist{flex:1;min-height:0;overflow:auto;font-size:12.5px}
  .sb-outline .oi{display:flex;align-items:center;gap:6px;padding:2px 5px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden}
  .sb-outline .oi:hover{background:rgba(82,242,201,.12)}
  .sb-outline .oi .nm{overflow:hidden;text-overflow:ellipsis}
  .sb-outline .oi .ln{margin-left:auto;color:var(--muted,#9a93b5);font-size:10.5px;flex:none}
  .sb-outline .badge{font-size:10px;border-radius:4px;padding:0 5px;flex:none}
  .sb-outline .b-section{background:var(--acc,#52F2C9);color:#06231c;font-weight:600}
  .sb-outline .b-function,.sb-outline .b-method{color:var(--fn,#3dd9ff)}
  .sb-outline .b-class{color:var(--kw,#b45cff)}
  .sb-outline .b-const,.sb-outline .b-let,.sb-outline .b-var{color:#ffb454}
  .sb-outline .oi.section{margin-top:4px;font-weight:600}
  .sb-outline .none{color:var(--muted,#9a93b5);font-style:italic;font-size:12px}
  `;
  document.head.appendChild(st);

  const panel = document.createElement('div'); panel.className = 'sb-outline';
  panel.innerHTML = '<div class="oh"><b>🗂 Структура</b><button id="olRef" title="обновить">⟳</button><button id="olX" title="закрыть">×</button></div>'
    + '<input class="of" id="olFilter" placeholder="фильтр по имени…"><div class="olist" id="olList"></div>';
  const edcol = box.querySelector('.sb-edcol') || edsEl;
  box.insertBefore(panel, edcol.parentNode === box ? edcol : edsEl);
  const listEl = panel.querySelector('#olList'), filterEl = panel.querySelector('#olFilter'), nameEl = panel.querySelector('b');

  let items = [], open = false, lastCode = null, lastId = null;
  function jump(it){
    const f = activeFile(); if(!f) return;
    const ta = taFor(f.id), cm = ta && ta.__cm, len = (it.name || '').length || 1;
    if(cm){ try { cm.refresh(); } catch(_){}   // пересчитать гуттер/разметку (иначе после прыжка текст налезает на номера)
      const from = cm.posFromIndex(it.off), to = cm.posFromIndex(it.off + len); cm.setSelection(from, to); cm.scrollIntoView({ from, to }, 80); cm.focus();
      setTimeout(() => { try { cm.refresh(); cm.scrollIntoView({ from, to }, 80); } catch(_){} }, 0); }
    else if(ta){ ta.focus(); try { ta.setSelectionRange(it.off, it.off + len); } catch(_){} }
  }
  function draw(){
    const flt = (filterEl.value || '').trim().toLowerCase();
    listEl.innerHTML = '';
    const show = flt ? items.filter(x => x.name.toLowerCase().includes(flt)) : items;
    if(!show.length){ listEl.innerHTML = '<div class="none">' + (items.length ? 'ничего не найдено' : 'нет функций/классов/секций — или язык не JS/TS/Python') + '</div>'; return; }
    show.forEach(it => {
      const row = document.createElement('div'); row.className = 'oi' + (it.kind === 'section' ? ' section' : '');
      if(!flt && it.kind !== 'section') row.style.paddingLeft = (5 + Math.min(it.depth, 5) * 12) + 'px';
      const bd = document.createElement('span'); bd.className = 'badge b-' + it.kind; bd.textContent = it.kind === 'section' ? '§' : it.kind; row.appendChild(bd);
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = it.name; row.appendChild(nm);
      const ln = document.createElement('span'); ln.className = 'ln'; ln.textContent = it.line; row.appendChild(ln);
      row.onclick = () => jump(it);
      listEl.appendChild(row);
    });
  }
  function rebuild(force){
    const f = activeFile();
    nameEl.textContent = '🗂 ' + (f ? (f.name || 'файл') : 'файл');
    if(!f){ items = []; listEl.innerHTML = '<div class="none">нет открытого файла</div>'; return; }
    if(!force && f.id === lastId && f.code === lastCode) return;   // не пересобирать зря
    lastId = f.id; lastCode = f.code;
    items = /^(js|ts|python)$/.test(f.lang || '') ? parse(f.code || '', f.lang) : parse(f.code || '', f.lang);  // секции ловим в любом языке
    draw();
  }

  filterEl.addEventListener('input', draw);
  panel.querySelector('#olRef').onclick = () => rebuild(true);
  panel.querySelector('#olX').onclick = () => { open = false; panel.classList.remove('on'); };

  // кнопка в панели песочницы
  const b = document.createElement('button'); b.className = 'btn'; b.id = 'sbOutlineBtn'; b.textContent = '🗂 структура';
  b.title = 'оглавление файла: функции, классы, константы, секции — фильтр и прыжок';
  b.onclick = () => { open = !open; panel.classList.toggle('on', open); if(open) rebuild(true); };
  const legend = bar.querySelector('#sbLegend'); if(legend) legend.after(b); else bar.appendChild(b);

  // пересборка: смена вкладки (childList) и правка (с задержкой — чтобы на больших файлах не дёргать)
  new MutationObserver(() => { if(open) rebuild(); }).observe(edsEl, { childList: true });
  let t = null; edsEl.addEventListener('input', () => { if(open){ clearTimeout(t); t = setTimeout(() => rebuild(true), 500); } }, true);
})();
