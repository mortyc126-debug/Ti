// «🧩 Разобрать»: готовый файл в песочнице раскладывается на компоненты (константы, функции, классы),
// их значения/поля и зависимости. Клик по компоненту или по слову в коде → панель справа, где значение
// правится прямо в окошке и пишется обратно в код. Эвристика по именам, не настоящий анализатор.
// Надстройка над window.codelabSandbox; после tabs.js/navigate.js (использует переход по вкладкам и analyze).
(function(){
  const sb = window.codelabSandbox;
  const box = document.getElementById('sandbox');
  const edsEl = box && box.querySelector('#sbEds');
  if(!sb || !box || !edsEl){ return; }

  const files = () => sb.getFiles();
  const activeId = () => { try { return localStorage.getItem('codelab_sb_active'); } catch(_){ return null; } };
  const activeFile = () => { const fs = files(); return fs.find(f => f.id === activeId()) || fs[0] || null; };
  const edFor = id => { for(const ed of edsEl.children){ if(ed.__f && ed.__f.id === id) return ed; } return null; };
  const taFor = id => { const ed = edFor(id); return ed ? ed.querySelector('textarea') : null; };
  const cmOf = id => { const ta = taFor(id); return ta && ta.__cm ? ta.__cm : null; };

  // ключевые слова/глобалы — «стандартные» имена (не авторские)
  const STD = new Set(('if else for while do switch case break continue return function class const let var new this true false null undefined '
    + 'typeof instanceof in of import export from default try catch finally throw async await yield static get set delete void '
    + 'document window console Math JSON Object Array String Number Boolean Date RegExp Map Set Promise fetch setTimeout setInterval '
    + 'parseInt parseFloat isNaN localStorage querySelector addEventListener length push map filter forEach').split(/\s+/));
  // частые «постоянные» имена полей (развилки со стандартными именами) — для пометки
  const STD_KEYS = new Set(('type name id value key class style src href method url mode async headers body status code title label '
    + 'width height color background font display position top left right bottom margin padding border '
    + 'onclick onchange oninput onsubmit target data default min max step rows cols placeholder').split(/\s+/));

  // убрать строки и комментарии (заменить пробелами той же длины) — для подсчёта глубины и поиска объявлений
  function blank(code){
    let out = '', i = 0, n = code.length;
    while(i < n){
      const c = code[i], two = code.slice(i, i + 2);
      if(two === '//'){ let j = i; while(j < n && code[j] !== '\n') j++; out += ' '.repeat(j - i); i = j; continue; }
      if(two === '/*'){ let j = i + 2; while(j < n && code.slice(j, j + 2) !== '*/') j++; j = Math.min(n, j + 2); out += ' '.repeat(j - i); i = j; continue; }
      if(c === '"' || c === "'" || c === '`'){ let j = i + 1; while(j < n && code[j] !== c){ if(code[j] === '\\') j++; j++; } j = Math.min(n, j + 1); out += ' '.repeat(j - i); i = j; continue; }
      out += c; i++;
    }
    return out;
  }
  const depthAt = (s, idx) => { let d = 0; for(let i = 0; i < idx; i++){ const c = s[i]; if(c === '{' || c === '(' || c === '[') d++; else if(c === '}' || c === ')' || c === ']') d--; } return d; };
  const lineOf = (code, idx) => (code.slice(0, idx).match(/\n/g) || []).length + 1;
  // конец выражения-значения от позиции после '=' (до ';' или перевода строки на нулевой глубине)
  function valueEnd(s, from){
    let d = 0, i = from, n = s.length;
    for(; i < n; i++){ const c = s[i]; if(c === '{' || c === '(' || c === '[') d++; else if(c === '}' || c === ')' || c === ']'){ if(d === 0) break; d--; } else if(d === 0 && (c === ';' || c === '\n')) break; }
    return i;
  }
  // конец тела функции/класса: от первой '{' после позиции — до парной '}'
  function bodyEnd(s, from){
    let i = s.indexOf('{', from); if(i < 0) return from;
    let d = 0; for(; i < s.length; i++){ const c = s[i]; if(c === '{') d++; else if(c === '}'){ d--; if(d === 0) return i + 1; } } return s.length;
  }

  // разобрать код на компоненты. Берём объявления на самом мелком уровне, где они есть:
  // для обычного файла это глубина 0, для файла в обёртке (IIFE/модуль «(() => { … })()») — 1.
  function parse(code){
    const s = blank(code), raw = [];
    const add = (kind, name, start, declEnd) => raw.push({ kind, name, start, declEnd, line: lineOf(code, start), depth: depthAt(s, start) });
    let m;
    const reV = /(?:^|[;{}\n])[ \t]*(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
    while((m = reV.exec(s))){ const nameI = m.index + m[0].indexOf(m[2]); const eq = m.index + m[0].length; add(m[1], m[2], nameI, valueEnd(s, eq)); }
    const reF = /(?:^|[;{}\n])[ \t]*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
    while((m = reF.exec(s))){ const nameI = m.index + m[0].indexOf(m[1]); add('function', m[1], nameI, bodyEnd(s, nameI)); }
    const reC = /(?:^|[;{}\n])[ \t]*class\s+([A-Za-z_$][\w$]*)/g;
    while((m = reC.exec(s))){ const nameI = m.index + m[0].indexOf(m[1]); add('class', m[1], nameI, bodyEnd(s, nameI)); }
    if(!raw.length) return [];
    const minD = Math.min(...raw.map(r => r.depth));
    const out = raw.filter(r => r.depth === minD);
    out.forEach(c => { c.value = code.slice(c.start, c.declEnd).trim(); });
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  // вид связи c → x по телу c, терминами единого словаря CODE_RELATIONS (relations.js).
  // Берём как можно более точный вид; порядок проверок = приоритет.
  function classifyRel(body, nm){
    const re = p => new RegExp(p).test(body);
    if(re('extends\\s+' + nm + '(?![\\w$])')) return 'extends';                 // расширяет (наследует)
    if(re('new\\s+' + nm + '(?![\\w$])')) return 'creates';                     // создаёт экземпляр
    if(re('(?<![\\w$])' + nm + '\\.addEventListener')) return 'listens';        // слушает событие
    if(re('(?<![\\w$])' + nm + '\\.(dispatchEvent|emit)\\s*\\(')) return 'emits'; // шлёт событие
    if(re('(?<![\\w$])' + nm + '\\.(push|pop|shift|unshift|splice|set|add|delete|clear|sort)\\s*\\(')) return 'mutates'; // меняет
    if(re('(?<![\\w$])' + nm + '\\.\\w+\\s*=(?!=)')) return 'mutates';          // меняет поле
    if(re('(?<![\\w$])' + nm + '\\s*\\(')) return 'calls';                      // вызывает
    if(re('(?<![\\w$])' + nm + '\\.\\w+')) return 'reads';                      // читает поле/значение
    return 'uses';                                                              // общее «использует»
  }

  // поля объекта-значения (ключи верхнего уровня) из value вида name = { ... }
  function objectFields(value){
    const bi = value.indexOf('{'); if(bi < 0) return [];
    const s = blank(value), fields = []; let m;
    const re = /([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*:/g;
    while((m = re.exec(s))){ if(depthAt(s, m.index) === 1){ const raw = m[1].replace(/['"]/g, ''); fields.push(raw); } }
    return fields;
  }

  // ── стили ──
  const st = document.createElement('style');
  st.textContent = `
  .sb-insp{flex:0 0 320px;max-width:46vw;min-height:0;display:none;flex-direction:column;gap:8px;
    background:var(--bg2,#150a2b);border:1px solid var(--border,#3a2f55);border-radius:10px;margin-left:8px;padding:10px;overflow:auto;font-size:12.5px}
  .sb-insp.on{display:flex}
  @media(max-width:1000px){.sb-insp{flex-basis:auto;max-width:none;margin:8px 0 0}}
  .sb-insp .ih{display:flex;align-items:center;gap:6px}
  .sb-insp .ih b{flex:1;font-size:13px}
  .sb-insp .grp{font-size:11px;color:var(--muted,#9a93b5);text-transform:uppercase;letter-spacing:.04em;margin:6px 0 2px}
  .sb-insp .comp{display:block;width:100%;text-align:left;background:transparent;border:0;color:var(--text,#eee);padding:4px 6px;border-radius:7px;cursor:pointer;font:12px/1.4 monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sb-insp .comp:hover{background:rgba(82,242,201,.12)}
  .sb-insp .comp.sel{background:rgba(82,242,201,.2)}
  .sb-insp .badge{font-size:10px;padding:1px 6px;border-radius:9px;margin-right:6px;background:var(--s2,#241038);color:var(--muted,#9a93b5)}
  .sb-insp .b-const{color:#ffb454}.sb-insp .b-let{color:#ffd080}.sb-insp .b-var{color:#ffd080}.sb-insp .b-function{color:var(--fn,#3dd9ff)}.sb-insp .b-class{color:var(--kw,#b45cff)}
  .sb-insp .det{border:1px solid var(--border,#3a2f55);border-radius:9px;padding:8px;background:var(--bg,#0e0720)}
  .sb-insp .det .nm{font:13px monospace;color:var(--name,#cbc2ea)}
  .sb-insp .role{font-size:11px;color:var(--muted,#9a93b5);margin:2px 0 6px}
  .sb-insp textarea.val{width:100%;box-sizing:border-box;min-height:54px;background:var(--code-bg,#0e0720);color:var(--text,#eee);border:1px solid var(--border,#3a2f55);border-radius:7px;padding:6px;font:12px/1.45 monospace;resize:vertical}
  .sb-insp .sig{font:12px/1.45 monospace;color:var(--text2,#cbc2ea);white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto}
  .sb-insp .chip{display:inline-block;background:var(--s2,#241038);border:1px solid var(--border,#3a2f55);border-radius:12px;padding:1px 9px;margin:2px 3px 0 0;font:11.5px monospace;cursor:pointer;color:var(--text,#eee)}
  .sb-insp .chip:hover{border-color:var(--acc,#52F2C9)}
  .sb-insp .chip.std{opacity:.7;cursor:default}
  .sb-insp .ref{display:block;width:100%;text-align:left;background:transparent;border:0;color:var(--text,#eee);padding:2px 5px;border-radius:6px;cursor:pointer;font:11.5px/1.4 monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sb-insp .ref:hover{background:rgba(82,242,201,.14)}
  .sb-insp .ref .fl{color:var(--muted,#9a93b5)}
  .sb-insp .none{color:var(--muted,#9a93b5);font-style:italic}
  .sb-insp .ibtn{background:var(--s2,#241038);border:1px solid var(--border,#3a2f55);color:var(--text,#eee);border-radius:7px;padding:3px 9px;cursor:pointer;font-size:12px}
  .sb-insp .ibtn:hover{border-color:var(--acc,#52F2C9)}
  `;
  document.head.appendChild(st);

  const panel = document.createElement('div'); panel.className = 'sb-insp';
  panel.innerHTML = '<div class="ih"><b>🧩 Разбор файла</b><button class="ibtn" id="inspRef" title="пересобрать">⟳</button><button class="ibtn" id="inspX" title="закрыть">×</button></div>'
    + '<div class="grp" id="inspProjH" style="display:none">Связи этого куска в проекте</div><div id="inspProj"></div>'
    + '<div class="grp">Компоненты файла</div><div id="inspList"></div>'
    + '<div class="grp">Подробно</div><div id="inspDet"><div class="none">выбери компонент сверху или кликни по имени в коде</div></div>';
  // встраиваем панель в раскладку песочницы (между кодом и превью), а не поверх — чтобы не наезжала
  const right = box.querySelector('.sb-right'); if(right) box.insertBefore(panel, right); else box.appendChild(panel);
  const listEl = panel.querySelector('#inspList'), detEl = panel.querySelector('#inspDet'), nameEl = panel.querySelector('b');
  const projEl = panel.querySelector('#inspProj'), projH = panel.querySelector('#inspProjH');
  let comps = [], selName = null, open = false, lastProjCode = null;

  // связи этого куска в проекте (из сохранённых схем): если открытый код совпал с сохранённым куском
  async function loadProjectRels(f){
    if(!f){ projEl.innerHTML = ''; projH.style.display = 'none'; return; }
    if(f.code === lastProjCode) return;           // не дёргать сервер на каждую перерисовку
    lastProjCode = f.code;
    let data = null;
    try { data = await fetch('/api/relations/piece', { method: 'POST', body: JSON.stringify({ code: f.code, title: (f.name || '').replace(/\.[^.]+$/, '') }) }).then(r => r.json()); } catch(_){}
    if(f.code !== lastProjCode) return;           // пока грузили — файл сменился
    projEl.innerHTML = '';
    const rels = (data && data.relations) || [];
    if(!rels.length){ projH.style.display = 'none'; return; }
    projH.style.display = '';
    rels.slice(0, 40).forEach(x => {
      const r = (window.relationById ? window.relationById(x.rel) : null), lbl = r ? r.label : x.rel, col = (window.relationColor ? window.relationColor(x.rel) : 'var(--acc)');
      const ch = document.createElement('span'); ch.className = 'chip std'; ch.style.borderColor = col;
      const t = document.createElement('span'); t.style.color = col; t.style.opacity = '.85';
      // out: этот → other ; in: other → этот
      t.textContent = x.dir === 'in' ? (x.other + ' ' + lbl + ' →') : (lbl + ' →');
      ch.appendChild(t); if(x.dir !== 'in') ch.appendChild(document.createTextNode(' ' + x.other));
      ch.title = (x.dir === 'in' ? (x.other + ' ' + lbl + ' этот кусок') : ('этот кусок ' + lbl + ' ' + x.other)) + (x.scheme ? ('  ·  схема: ' + x.scheme) : '');
      projEl.appendChild(ch);
    });
  }

  function rebuild(){
    const f = activeFile();
    nameEl.textContent = '🧩 ' + (f ? (f.name || 'файл') : 'файл');
    loadProjectRels(f);
    comps = f && /^(js|ts)$/.test(f.lang) ? parse(f.code || '') : [];
    listEl.innerHTML = '';
    if(!f){ listEl.innerHTML = '<div class="none">нет открытого файла</div>'; return; }
    if(!/^(js|ts)$/.test(f.lang)){ listEl.innerHTML = '<div class="none">разбор пока для JS/TS; для ' + (f.lang || '?') + ' — клик по имени тоже работает</div>'; return; }
    if(!comps.length){ listEl.innerHTML = '<div class="none">не нашлось объявлений const/let/function/class</div>'; return; }
    comps.forEach(c => {
      const b = document.createElement('button'); b.className = 'comp' + (c.name === selName ? ' sel' : '');
      b.innerHTML = '<span class="badge b-' + c.kind + '">' + c.kind + '</span>';
      b.appendChild(document.createTextNode(c.name + '  ')); const ln = document.createElement('span'); ln.className = 'fl'; ln.style.color = 'var(--muted,#9a93b5)'; ln.style.fontSize = '11px'; ln.textContent = 'стр. ' + c.line; b.appendChild(ln);
      b.onclick = () => { selName = c.name; selectInCode(c); showDetail(c.name); rebuild(); };
      listEl.appendChild(b);
    });
    // авто-выбор: чтобы «Подробно» не было пустым — показываем первый компонент
    if(!selName || !comps.find(x => x.name === selName)){ selName = comps[0].name; showDetail(selName); }
  }

  function selectInCode(c){
    const f = activeFile(); if(!f) return;
    const ta = taFor(f.id), cm = ta && ta.__cm;
    if(cm){ const from = cm.posFromIndex(c.start), to = cm.posFromIndex(c.start + c.name.length); cm.setSelection(from, to); cm.scrollIntoView({ from, to }, 60); }
    else if(ta){ ta.focus(); try { ta.setSelectionRange(c.start, c.start + c.name.length); } catch(_){} }
  }

  function writeValue(c, newVal){
    const f = activeFile(); if(!f) return;
    const code = f.code || '';
    // c.declEnd — конец значения; начало значения — после первого '=' в срезе
    const eq = code.indexOf('=', c.start); if(eq < 0 || eq > c.declEnd) return;
    const next = code.slice(0, eq + 1) + ' ' + newVal + code.slice(c.declEnd);
    const id = f.id;
    sb.setFiles(files().map(x => x.id === id ? { ...x, code: next } : x));
    setTimeout(() => { rebuild(); showDetail(c.name); }, 0);
  }

  // данные по слову: если объявлено в файле — компонент; иначе сначала пояснение из словаря
  // (CSS-свойства/значения, HTML-теги, ключевые слова — та же база, что у «пояснений по клику»)
  function showWord(word){
    const c = comps.find(x => x.name === word);
    if(c){ selName = word; showDetail(word); rebuild(); return; }
    const f = activeFile(), lang = f ? f.lang : '';
    const expl = window.codelabExplain ? window.codelabExplain(word, lang) : null;
    detEl.innerHTML = '';
    const d = document.createElement('div'); d.className = 'det';
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = word; d.appendChild(nm);
    if(expl){
      // нашли пояснение в словаре — показываем его (главное, что хотел пользователь)
      const b = document.createElement('div'); b.className = 'sig'; b.style.whiteSpace = 'pre-wrap'; b.textContent = expl; d.appendChild(b);
      // для HTML/CSS список вхождений не нужен — это шум; для кода покажем, где встречается
      if(/^(js|ts)$/.test(lang || '')) appendUsages(d, word);
    } else {
      const role = document.createElement('div'); role.className = 'role';
      role.textContent = STD.has(word) ? 'стандартное имя (ключевое слово / встроенное — его смысл задан языком)'
        : (/^(css|html|htm)$/.test(lang || '') ? 'нет пояснения в словаре для этого слова (можно добавить в keyword-dict.json)'
          : 'имя не объявлено в этом файле (приходит извне или задаётся глубже верхнего уровня)');
      d.appendChild(role);
      if(!STD.has(word) && /^(js|ts)$/.test(lang || '')) appendUsages(d, word);
    }
    detEl.appendChild(d);
  }

  function appendUsages(d, name){
    const nav = window.codelabNav;
    let uses = [];
    if(nav && nav.analyze){ uses = nav.analyze(name).uses; }
    const g = document.createElement('div'); g.className = 'grp'; g.textContent = 'Используется (' + uses.length + ')'; d.appendChild(g);
    if(!uses.length){ const n = document.createElement('div'); n.className = 'none'; n.textContent = 'нет вхождений'; d.appendChild(n); return; }
    uses.slice(0, 30).forEach(u => {
      const b = document.createElement('button'); b.className = 'ref';
      const fl = document.createElement('span'); fl.className = 'fl'; fl.textContent = (u.name || '') + ':' + u.line + '  '; b.appendChild(fl);
      b.appendChild(document.createTextNode(u.text || ''));
      b.onclick = () => { if(nav && nav.jump) nav.jump(u); };
      d.appendChild(b);
    });
  }

  function showDetail(name){
    const c = comps.find(x => x.name === name); if(!c){ showWord(name); return; }
    detEl.innerHTML = '';
    const d = document.createElement('div'); d.className = 'det';
    const head = document.createElement('div'); head.innerHTML = '<span class="badge b-' + c.kind + '">' + c.kind + '</span>';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = c.name; head.appendChild(nm); d.appendChild(head);
    const role = document.createElement('div'); role.className = 'role'; role.textContent = 'своё имя (задано в файле, строка ' + c.line + ') — можно переименовать в коде'; d.appendChild(role);

    if(c.kind === 'function' || c.kind === 'class'){
      const sig = document.createElement('div'); sig.className = 'sig';
      sig.textContent = c.value.split('\n').slice(0, 6).join('\n') + (c.value.split('\n').length > 6 ? '\n…' : '');
      d.appendChild(sig);
      const go = document.createElement('button'); go.className = 'ibtn'; go.textContent = '→ перейти в коде'; go.style.marginTop = '6px'; go.onclick = () => selectInCode(c); d.appendChild(go);
    } else {
      // const/let/var — значение правится в окошке
      const g = document.createElement('div'); g.className = 'grp'; g.textContent = 'Значение (правь и сохрани)'; d.appendChild(g);
      const code = (activeFile() || {}).code || ''; const eq = code.indexOf('=', c.start);
      const valText = eq >= 0 ? code.slice(eq + 1, c.declEnd).trim() : c.value;
      const ta = document.createElement('textarea'); ta.className = 'val'; ta.value = valText; ta.spellcheck = false; d.appendChild(ta);
      const row = document.createElement('div'); row.style.marginTop = '6px'; row.style.display = 'flex'; row.style.gap = '6px';
      const save = document.createElement('button'); save.className = 'ibtn'; save.textContent = '💾 записать в код';
      save.onclick = () => writeValue(c, ta.value.trim());
      const go = document.createElement('button'); go.className = 'ibtn'; go.textContent = '→ в коде'; go.onclick = () => selectInCode(c);
      row.append(save, go); d.appendChild(row);

      // поля-«развилки» для объекта
      const fields = objectFields(valText);
      if(fields.length){
        const gf = document.createElement('div'); gf.className = 'grp'; gf.textContent = 'Поля (' + fields.length + ')'; d.appendChild(gf);
        const wrap = document.createElement('div');
        fields.forEach(k => { const ch = document.createElement('span'); ch.className = 'chip' + (STD_KEYS.has(k) ? ' std' : ''); ch.textContent = k + (STD_KEYS.has(k) ? ' · станд.' : ' · своё'); wrap.appendChild(ch); });
        d.appendChild(wrap);
      }
    }

    // связи с другими компонентами файла — видами из единого словаря CODE_RELATIONS
    const body = c.value;
    const deps = [];
    comps.filter(x => x.name !== c.name).forEach(x => {
      const nm = x.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if(!new RegExp('(?<![\\w$])' + nm + '(?![\\w$])').test(body)) return;
      deps.push({ name: x.name, rel: classifyRel(body, nm) });
    });
    const gd = document.createElement('div'); gd.className = 'grp'; gd.textContent = 'Связи с компонентами файла (' + deps.length + ')'; d.appendChild(gd);
    if(deps.length){ const w = document.createElement('div'); deps.forEach(x => {
      const r = (window.relationById ? window.relationById(x.rel) : null), lbl = r ? r.label : x.rel, col = (window.relationColor ? window.relationColor(x.rel) : 'var(--acc)');
      const ch = document.createElement('span'); ch.className = 'chip'; ch.style.borderColor = col;
      const t = document.createElement('span'); t.textContent = lbl + ' → '; t.style.color = col; t.style.opacity = '.85'; ch.appendChild(t); ch.appendChild(document.createTextNode(x.name));
      ch.title = c.name + ' ' + lbl + ' ' + x.name;
      ch.onclick = () => { selName = x.name; const cc = comps.find(y => y.name === x.name); if(cc) selectInCode(cc); showDetail(x.name); rebuild(); }; w.appendChild(ch);
    }); d.appendChild(w); }
    else { const n = document.createElement('div'); n.className = 'none'; n.textContent = 'не связан с другими компонентами файла'; d.appendChild(n); }

    appendUsages(d, c.name);
    detEl.appendChild(d);
  }

  // клик по слову в коде, когда панель открыта; заодно отдаём номер строки
  const DECL_KW = new Set(['const', 'let', 'var', 'function', 'class']);
  function wordAt(ed, ev){
    const ta = ed.querySelector('textarea'), cm = ta && ta.__cm;
    const f = ed.__f, css = f && /^(css|html|htm)$/.test(f.lang || '');
    // в CSS/HTML имя может содержать дефис и цифры (grid-template-columns, 1fr) — ловим шире
    const ch = css ? /[\w$-]/ : /[\w$]/;
    if(cm){ const pos = cm.coordsChar({ left: ev.clientX, top: ev.clientY }, 'window');
      if(css){ const ln = cm.getLine(pos.line) || ''; let a = pos.ch, b = pos.ch; while(a > 0 && ch.test(ln[a - 1])) a--; while(b < ln.length && ch.test(ln[b])) b++; return { w: ln.slice(a, b), line: pos.line + 1 }; }
      const r = cm.findWordAt(pos); return { w: (cm.getRange(r.anchor, r.head) || '').trim(), line: pos.line + 1 }; }
    if(ta){ const v = ta.value, cc = ta.selectionStart; let a = cc, b = cc; while(a > 0 && ch.test(v[a - 1])) a--; while(b < v.length && ch.test(v[b])) b++; return { w: v.slice(a, b), line: (v.slice(0, cc).match(/\n/g) || []).length + 1 }; }
    return { w: '', line: 0 };
  }
  // строка и позиция под кликом — для распознавания конструкции
  function lineColAt(ed, ev){
    const ta = ed.querySelector('textarea'), cm = ta && ta.__cm;
    if(cm){ const pos = cm.coordsChar({ left: ev.clientX, top: ev.clientY }, 'window'); return { text: cm.getLine(pos.line) || '', col: pos.ch }; }
    if(ta){ const v = ta.value, c = ta.selectionStart; const nl = v.lastIndexOf('\n', c - 1) + 1; const end = v.indexOf('\n', c); return { text: v.slice(nl, end < 0 ? v.length : end), col: c - nl }; }
    return { text: '', col: 0 };
  }
  edsEl.addEventListener('click', ev => {
    if(!open) return;
    const ed = ev.target.closest && ev.target.closest('.sb-ed'); if(!ed || !ed.__f) return;
    setTimeout(() => {
      // сперва — конструкция под курсором (for…of, std::cout, try/catch): показываем её пояснение
      const loc = lineColAt(ed, ev);
      const con = window.codelabExplainAt ? window.codelabExplainAt(loc.text, loc.col, ed.__f.lang || '') : null;
      if(con){ showWord(con.term); return; }
      const { w, line } = wordAt(ed, ev);
      // для css/html допускаем дефис и цифры (grid-template-columns, 1fr), для кода — обычное имя
      const ok = /^(css|html|htm)$/.test(ed.__f.lang || '') ? /^[A-Za-z0-9_$-]{2,}$/.test(w) : /^[A-Za-z_$][\w$]*$/.test(w);
      if(!w || !ok) return;
      // клик по слову-объявлению (const/function/…) → показать саму константу/функцию на этой строке
      if(DECL_KW.has(w)){ const c = comps.find(x => x.line === line); if(c){ selName = c.name; showDetail(c.name); rebuild(); return; } }
      showWord(w);
    }, 0);
  }, true);

  panel.querySelector('#inspRef').onclick = () => rebuild();
  panel.querySelector('#inspX').onclick = () => { open = false; panel.classList.remove('on'); };

  // кнопка в панели песочницы
  const bar = box.querySelector('.sb-bar');
  if(bar){ const b = document.createElement('button'); b.className = 'btn'; b.id = 'sbInspBtn'; b.textContent = '🧩 разобрать'; b.title = 'разложить файл на компоненты, значения и зависимости — править в окошке справа';
    b.onclick = () => { open = !open; panel.classList.toggle('on', open); if(open) rebuild(); };
    const legend = bar.querySelector('#sbLegend'); if(legend) legend.after(b); else bar.appendChild(b); }

  // при переключении вкладки — пересобрать, если открыто
  new MutationObserver(() => { if(open) rebuild(); }).observe(edsEl, { childList: true });
})();
