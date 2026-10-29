// «что это?»: выделяешь код — рядом появляется кнопка; по ней (или alt+q) открывается схемка.
// над каждым узнанным куском — скобка с короткой подписью («внешний отступ», «найти элемент»), ниже расшифровка.
// подписи берутся из синонимов и словаря. у разновидности — путь к смыслу («внешний отступ › margin-trim»).
// свои имена файла показывают, что в них лежит и где объявлены (/api/code/names), опечатки — красной скобкой.
// подключается после sandbox.js.
(function(){
  const box = document.getElementById('sandbox');
  const edsEl = box && box.querySelector('#sbEds');
  if(!edsEl || !window.codelabExplain) return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const MAX_CHARS = 2000, MAX_LINES = 30;

  const st = document.createElement('style');
  st.textContent = `
  .sx-btn{position:fixed;z-index:9995;background:var(--bg2,#150a2b);color:var(--text,#eee);border:1px solid var(--name,#3dd9ff);border-radius:7px;
    font:12px system-ui,sans-serif;padding:4px 8px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.45)}
  .se{position:fixed;z-index:9996;width:min(760px,94vw);max-height:70vh;display:flex;flex-direction:column;background:var(--bg2,#150a2b);
    border:1px solid var(--border,#3a2f55);border-radius:12px;box-shadow:0 12px 34px rgba(0,0,0,.55);overflow:hidden}
  .se-h{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--border,#3a2f55);font-size:12.5px;color:var(--text2,#cbc2ea)}
  .se-h b{flex:1}
  .se-h button{background:none;border:0;color:var(--text2,#cbc2ea);font-size:15px;cursor:pointer}
  .se-b{overflow:auto;padding:10px 12px}
  /* подписи не раздвигают код: стоят над ним абсолютно, в два ряда по очереди — соседние не налезают */
  .se-line{font:14px/1.3 ui-monospace,monospace;color:var(--text2,#cbc2ea);white-space:pre;padding-top:40px;margin-bottom:4px;position:relative}
  .se-seg{position:relative;display:inline}
  .se-lbl{position:absolute;left:0;bottom:calc(100% + 8px);font:11px/1.2 system-ui,sans-serif;color:var(--text,#f6f4ff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  
  .se-br{position:absolute;left:0;right:0;bottom:calc(100% + 1px);height:6px;border:1.5px solid var(--name,#3dd9ff);border-bottom:0;border-radius:4px 4px 0 0}
  .se-seg.up .se-br::before{content:'';position:absolute;left:3px;bottom:100%;height:calc(var(--lift,15px) + 1px);border-left:1px dashed var(--text3,#9c90c4)}
  .se-code{color:var(--text,#f6f4ff)}
  .cm-se-flash{background:rgba(61,217,255,.18)}
  .se-lbl i{font-style:normal;font-weight:700;color:var(--acc,#ff2fae);margin-right:4px}
  .se-seg.rel .se-br{border-width:2px;border-color:var(--acc,#ff2fae)}
  .se-flow{margin-top:10px;border-top:1px solid var(--border,#3a2f55);padding-top:8px;font-size:12.5px;line-height:1.55}
  .se-flow div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-left:1px solid var(--border,#3a2f55);padding-left:8px}
  .se-flow b{color:var(--acc,#ff2fae);font-weight:700;display:inline-block;min-width:92px}
  .se-flow code{font:12.5px ui-monospace,monospace;color:var(--name,#3dd9ff);margin-right:6px}
  .se-flow span{color:var(--text3,#9c90c4)}
  .se-seg.own{cursor:pointer} .se-seg.own .se-br{border-style:dashed}
  .se-seg.typo .se-br{border-color:var(--err,#ff5c7a)!important;border-style:solid} .se-seg.typo .se-lbl{color:var(--err,#ff5c7a)}
  .se-seg.typo .se-code{text-decoration:underline wavy var(--err,#ff5c7a)}
  .se-it.typo code{color:var(--err,#ff5c7a)} .se-it a{color:var(--name,#3dd9ff);cursor:pointer;margin-left:6px}
  .se-seg.k2 .se-br{border-color:var(--str,#52F2C9)} .se-seg.k3 .se-br{border-color:var(--kw,#b45cff)} .se-seg.k4 .se-br{border-color:var(--fn,#ff2fae)}
  .se-list{margin-top:10px;border-top:1px solid var(--border,#3a2f55);padding-top:8px;display:flex;flex-direction:column;gap:5px}
  .se-it{font-size:12.5px;line-height:1.45;color:var(--text3,#9c90c4)}
  .se-it code{font:12.5px ui-monospace,monospace;color:var(--name,#3dd9ff);margin-right:6px}
  .se-it .r{font:11.5px ui-monospace,monospace;color:var(--str,#52F2C9);margin:1px 0 0 14px;white-space:pre-wrap}
  .se-it .p{color:var(--text2,#cbc2ea)}
  .se-none{color:var(--text3,#9c90c4);font-size:12.5px}
  `;
  document.head.appendChild(st);

  // свои имена файла — один запрос на весь код; только там, где разбор умеет объявления
  async function ownNames(code, lang){
    if(!/^(js|javascript|ts|typescript|jsx|python|py)$/i.test(lang) || !code.trim()) return null;
    const l = /^py/i.test(lang) ? 'python' : 'js';
    return fetch('/api/code/names', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.slice(0, 200000), lang: l }) })
      .then(r => r.ok ? r.json() : null).catch(() => null);
  }
  let DICT = null;
  const dict = async () => DICT || (DICT = await (window.codelabKwDict ? window.codelabKwDict() : fetch('/keyword-dict.json').then(r => r.json())).catch(() => ({})));
  const activeCM = () => { const ed = [...edsEl.children].find(e => e.__f && e.__f.id === (localStorage.getItem('codelab_sb_active') || '')) || edsEl.firstElementChild; const ta = ed && ed.querySelector('textarea'); return { cm: ta && ta.__cm, ta, lang: (ed && ed.__f && ed.__f.lang) || '' }; };

  // короткая подпись над скобкой: синоним («внешний отступ»), иначе первые слова пояснения
  const shortOf = t => { const s = String(t || '').replace(/^[^—]{1,40}—\s*/, '').replace(/^[^:а-яё]{1,40}:\s+/i, ''); // первая часть пояснения до «;»/«(» целиком, а не первые 4 слова — «включает режим flex для…» ничего не объясняет
    const c = s.split(/\s*[;(]\s*|\s+—\s+/)[0].trim(); return c.length > 70 ? c.slice(0, 68).replace(/\s+\S*$/, '') + '…' : c; };
  function meaning(term, lang, d){
    const syn = d.synonyms || {}; const lt = term.toLowerCase();
    const label = Array.isArray(syn[lt]) && syn[lt][0] ? syn[lt][0] : '';
    // разновидность: margin-trim → смысл предка margin («внешний отступ»)
    let path = '';
    const note = window.codelabExplain(term, lang) || '';
    // у своей записи предка не берём: color-scheme — не «цвет букв», хоть и начинается с color
    if(!label && !note && lt.includes('-')) for(let p = lt.lastIndexOf('-'); p > 0; p = lt.lastIndexOf('-', p - 1)){ const pre = lt.slice(0, p); if(Array.isArray(syn[pre]) && syn[pre][0]){ path = syn[pre][0] + ' › ' + term; break; } }
    return { label: label || (path ? path.split(' › ')[0] : '') || shortOf(note), path, note };
  }

  // разбить строку на узнанные куски: конструкции словаря (длинные) и слова
  // связь куска (когда/если/…): общий модуль code-links.js; пустая правка «нет» — связи нет
  const relOf = (term, lang, d, note) => { const L = window.codelabLinks; const r = L && L.relationOf(term, lang, d, note); return (r && r.rel) || ''; };
  const OPENS = new Set(['когда', 'если', 'иначе', 'для каждого', 'при ошибке', 'потом']);
  const inStrAt = (line, i) => { const before = line.slice(0, i); return ((before.match(/'/g) || []).length % 2) || ((before.match(/"/g) || []).length % 2) || ((before.match(/`/g) || []).length % 2); };
  function segments(line, lang, d, own, ln){
    const out = []; const re = lang === 'css' || lang === 'html' ? /[#.]?[\w-]+(?:\([^)]*\))?/g : /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g;
    let m; const taken = [];
    // свои имена и опечатки — раньше словаря: «что внутри btn» важнее, чем «btn — непонятное слово»
    if(own) for(const w of line.matchAll(/[A-Za-zА-Яа-яЁё_$][\wА-Яа-яЁё$]*/g)){
      if(inStrAt(line, w.index)) continue;
      const from = w.index, to = from + w[0].length;
      const ty = own.typos.find(t => t.name === w[0] && t.line === ln);
      if(ty){ taken.push([from, to]); out.push({ from, to, text: w[0], typo: ty, label: 'опечатка? → ' + ty.maybe,
        note: ty.kind === 'метод' ? 'такого нет в словаре, похоже на ' + ty.maybe : 'имя нигде не объявлено, похоже на ' + ty.maybe + (ty.declLine != null ? ' (строка ' + (ty.declLine + 1) + ')' : '') }); continue; }
      const nm = own.names[w[0]];
      if(nm && line[from - 1] !== '.'){ taken.push([from, to]); out.push({ from, to, text: w[0], own: nm, label: nm.text || 'своё имя', rel: line[to] === '[' ? 'откуда' : '',
        note: (nm.text ? nm.text + '; ' : '') + (nm.line === ln ? 'объявлено здесь' : 'объявлено в строке ' + (nm.line + 1)) }); }
    }
    // конструкции: пробуем в начале каждого слова, берём, если накрывают 2+ слова
    if(window.codelabExplainAt) for(const w of line.matchAll(/[A-Za-z_$#.@][\w$-]*/g)){
      if(taken.some(([a, b]) => w.index >= a && w.index < b)) continue;
      const hit = window.codelabExplainAt(line, w.index + 1, lang);
      if(hit && hit.term && hit.to - hit.from > w[0].length + 1){ taken.push([hit.from, hit.to]); out.push({ from: hit.from, to: hit.to, text: line.slice(hit.from, hit.to), label: shortOf(hit.text), note: hit.text, path: '', rel: relOf(hit.term, lang, d, hit.text) }); }
    }
    const free = [];
    while((m = re.exec(line))){
      // цепочку режем занятыми кусками: btn.classList.togle → classList (btn — своё имя, togle — опечатка)
      let a = m.index; const end = a + m[0].length;
      for(const [x, y] of taken.filter(([x, y]) => x < end && y > a).sort((p, q) => p[0] - q[0])){ if(x > a) free.push([a, x]); a = Math.max(a, y); }
      if(a < end) free.push([a, end]);
    }
    for(let [from, to] of free){
      while(line[from] === '.' && lang !== 'css' && lang !== 'html') from++; while(to > from && line[to - 1] === '.') to--;
      if(to <= from) continue; m = [line.slice(from, to)];
      // короткое слово внутри строки — скорее данные ('on', 'id'), чем термин: не объясняем
      const inStr = inStrAt(line, from);
      if(inStr && m[0].length < 4) continue;
      // цепочка obj.method — пробуем целиком, потом последнее звено (document.querySelector → querySelector)
      let term = m[0].replace(/\(.*$/, ''), info = meaning(term, lang, d);
      if(!info.note && !info.path && term.includes('.')){ const last = term.split('.').pop(); const i2 = meaning(last, lang, d); if(i2.note || i2.path) info = i2; }
      // связь: ядро языка / правка / начало пояснения; запись «obj.prop =» — всегда «куда», в любом языке
      // (свойство после своего имени приходит без точки: img.src → «src», точка стоит перед ним)
      let rel = relOf(term, lang, d, info.note);
      if(lang !== 'css' && lang !== 'html' && (term.includes('.') || line[from - 1] === '.') && /^\s*[-+*/]?=(?!=)/.test(line.slice(to))) rel = 'куда';
      if(!info.note && !info.path && !rel) continue;
      out.push({ from, to, text: m[0], ...info, rel, label: info.label || (rel === 'куда' ? 'записать сюда' : '') });
    }
    return out.sort((a, b) => a.from - b.from);
  }

  // подписи раскладываем по рядам после отрисовки: подпись идёт в первый ряд, где не налезает на соседнюю
  // раскладка подписей над скобками. подписи разной длины, а скобки стоят близко, поэтому раскладываем по рядам,
  // как машины по полосам: для каждой подписи ищем самый нижний ряд, где она не налезет на предыдущую
  // (rows[r] — где заканчивается последняя подпись в ряду r). не нашли — открываем новый ряд выше.
  // если подпись не влезает до правого края — сдвигаем её влево (shift), а скобка остаётся над своим кодом.
  // высота строки растёт на число рядов, чтобы подписи не залезали на строку выше.
  function layout(root){
    for(const ln of root.querySelectorAll('.se-line')){
      const rows = []; let max = 0;
      for(const seg of ln.querySelectorAll('.se-seg')){
        // подпись целиком: не влезает до правого края — сдвигаем влево (скобка остаётся на месте), режем только шире окна
        const lb = seg.querySelector('.se-lbl'); const box = ln.getBoundingClientRect(); const x0 = seg.getBoundingClientRect().left;
        lb.style.maxWidth = (box.width - 8) + 'px'; const w = lb.offsetWidth;
        const shift = Math.max(0, Math.min(x0 + w - (box.right - 4), x0 - box.left)); lb.style.left = -shift + 'px';
        const a = x0 - shift;
        let r = rows.findIndex(end => end + 6 <= a); if(r < 0){ r = rows.length; rows.push(0); }
        rows[r] = a + w; max = Math.max(max, r);
        lb.style.bottom = 'calc(100% + ' + (8 + r * 15) + 'px)';
        const br = seg.querySelector('.se-br'); br.style.setProperty('--lift', (r * 15) + 'px'); seg.classList.toggle('up', r > 0);
      }
      // строка без подписей (пустая, «}») не раздувается
      ln.style.paddingTop = ln.querySelector('.se-seg') ? (26 + max * 15) + 'px' : '2px';
    }
  }
  let btn = null, panel = null;
  const hideBtn = () => { if(btn){ btn.remove(); btn = null; } };
  function showBtn(x, y){
    hideBtn(); btn = document.createElement('button'); btn.className = 'sx-btn'; btn.textContent = 'что это?'; btn.title = 'разобрать выделенный код (Alt+Q)';
    btn.style.left = Math.min(x + 8, innerWidth - 120) + 'px'; btn.style.top = Math.min(y + 6, innerHeight - 40) + 'px';
    btn.onmousedown = e => e.preventDefault(); btn.onclick = open; document.body.appendChild(btn);
  }
  async function open(){
    hideBtn();
    const { cm, ta, lang } = activeCM();
    let text = cm ? cm.getSelection() : (ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '');
    let base = cm ? cm.getCursor('from').line : 0;
    if(!text.trim() && cm){ const c = cm.getCursor(); text = cm.getLine(c.line); base = c.line; }   // без выделения — текущая строка
    // выделение с середины строки: дописываем начало, иначе номера и позиции съедут
    if(cm && cm.somethingSelected()){ const f = cm.getCursor('from'); text = cm.getLine(f.line).slice(0, f.ch).replace(/\S/g, ' ') + text; }
    text = text.slice(0, MAX_CHARS);
    const [d, own] = await Promise.all([dict(), ownNames(cm ? cm.getValue() : (ta ? ta.value : ''), lang)]);
    // правила структуры языка: «внутри ul, ol», «требует display: flex», «пишется …» — в расшифровку
    const SL = /^py/.test(lang) ? 'python' : /^(ts|typescript|javascript|jsx)$/.test(lang) ? 'js' : lang;
    const srules = window.StructureRules ? window.StructureRules.parse(((d.structure || {})[SL] || []).join('\n')).rules : [];
    const ruleOf = t => window.StructureRules ? window.StructureRules.describe(String(t).replace(/^[.#<\/]+/, '').split('.').pop().replace(/\(.*$/, ''), srules) : [];
    if(panel) panel.remove();
    panel = document.createElement('div'); panel.className = 'se';
    const lines = text.split('\n').slice(0, MAX_LINES);
    let k = 0; const all = [];
    const body = lines.map((line, i) => {
      const segs = segments(line, lang, d, own, base + i); let pos = 0, h = '';
      for(const s of segs){ if(s.from < pos) continue; h += esc(line.slice(pos, s.from));
        const go = s.own ? ' data-go="' + s.own.line + '"' : s.typo && s.typo.declLine != null ? ' data-go="' + s.typo.declLine + '"' : '';
        h += '<span class="se-seg k' + (1 + (k % 4)) + '' + (s.own ? ' own' : '') + (s.typo ? ' typo' : '') + (s.rel && !s.typo ? ' rel' : '') + '"' + go + ' title="' + esc((s.rel ? s.rel + ': ' : '') + (s.note || '')) + '"><span class="se-lbl">' + (s.rel && !s.typo ? '<i>' + esc(s.rel) + '</i>' : '') + esc(s.rel && !s.label ? '' : (s.label || '…')) + '</span><span class="se-br"></span><span class="se-code">' + esc(s.text) + '</span></span>';
        k++;
        pos = s.to; s.ln = i; all.push(s); }
      return '<div class="se-line">' + h + esc(line.slice(pos)) + '</div>';
    }).join('');
    // лесенка связей: вложенность по скобкам/отступам; в той же строке после «если/когда…» — ещё на ступень
    const L = window.codelabLinks, dep = L ? L.depths(lines.join('\n'), lang) : lines.map(() => 0);
    const stack = []; const lineLvl = [];
    lines.forEach((_, i) => { while(stack.length && stack[stack.length - 1].d >= dep[i]) stack.pop(); lineLvl[i] = stack.filter(x => x.rel).length;
      const op = all.find(s => s.ln === i && OPENS.has(s.rel)); stack.push({ d: dep[i], rel: op ? op.rel : '' }); });
    let lastLn = -1, bump = 0;
    const flowRows = all.filter(s => s.rel && !s.typo).map(s => { if(s.ln !== lastLn){ lastLn = s.ln; bump = 0; }
      const lvl = lineLvl[s.ln] + bump; if(OPENS.has(s.rel)) bump = 1;
      return '<div style="margin-left:' + (lvl * 16) + 'px"><b>' + esc(s.rel) + '</b><code>' + esc(s.text) + '</code><span>' + esc(s.label && s.label !== 'записать сюда' ? s.label : '') + '</span></div>'; });
    const flow = flowRows.length > 1 ? '<div class="se-flow">' + flowRows.join('') + '</div>' : '';
    const seen = new Set();
    const list = all.filter(s => { const key = s.text.toLowerCase(); if(seen.has(key)) return false; seen.add(key); return true; })
      .map(s => '<div class="se-it' + (s.typo ? ' typo' : '') + '"><code>' + esc(s.text) + '</code>' + (s.path ? '<span class="p">' + esc(s.path) + '</span> — ' : '') + esc(s.note || s.label || s.rel)
        + (s.typo && cm ? '<a data-fix="' + esc(s.text) + '" data-to="' + esc(s.typo.maybe) + '">исправить</a>' : '')
        + (s.own && cm ? '<a data-go="' + s.own.line + '">к объявлению</a>' : '')
        + ruleOf(s.text).map(x => '<div class="r">' + esc(x) + '</div>').join('') + '</div>').join('');
    panel.innerHTML = '<div class="se-h"><b>что здесь</b><span>' + esc(lang.toUpperCase()) + '</span><button title="закрыть (Esc)">×</button></div>'
      + '<div class="se-b">' + (all.length ? body + flow + '<div class="se-list">' + list + '</div>' : '<div class="se-none">в выделенном нет слов из словаря — выдели кусок побольше или добавь пояснения в словарь</div>') + '</div>';
    document.body.appendChild(panel);
    layout(panel);
    panel.querySelector('.se-h button').onclick = () => { panel.remove(); panel = null; };
    panel.querySelector('.se-b').addEventListener('click', e => {
      if(!cm) return;
      const fix = e.target.closest('[data-fix]');
      // исправить — все вхождения в файле как отдельного слова (после точки — только методы, иначе только имена)
      if(fix){ const w = fix.dataset.fix, to = fix.dataset.to, src = cm.getValue();
        const re = new RegExp('(^|[^\\wА-Яа-яЁё$])' + w.replace(/[$]/g, '\\$&') + '(?![\\wА-Яа-яЁё$])', 'g');
        cm.operation(() => { for(let i = cm.lineCount() - 1; i >= 0; i--){ const l = cm.getLine(i); const nl = l.replace(re, (m0, p) => p + to); if(nl !== l) cm.replaceRange(nl, { line: i, ch: 0 }, { line: i, ch: l.length }); } });
        fix.closest('.se-it').style.opacity = '.45'; fix.remove(); return; }
      const go = e.target.closest('[data-go]');
      if(go){ const ln = +go.dataset.go; cm.focus(); cm.setCursor({ line: ln, ch: 0 }); cm.scrollIntoView({ line: ln, ch: 0 }, 80);
        const h = cm.addLineClass(ln, 'background', 'cm-se-flash'); setTimeout(() => cm.removeLineClass(h, 'background', 'cm-se-flash'), 1200); }
    });
    if(window.codelabWindow) window.codelabWindow.make(panel, { handle: panel.querySelector('.se-h'), key: 'codelab_win_se', defaultGeo: { w: 640, h: 380 }, minW: 320, minH: 180 });
    // окно получает свой размер (и меняет его при растягивании) уже после первой раскладки — подписи пересчитываем
    const me = panel; let rt = null;
    if(window.ResizeObserver) new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if(me.isConnected) layout(me); }, 60); }).observe(me);
  }

  // выделение в CodeMirror → кнопка у конца выделения; снял выделение — кнопка ушла
  let t = null;
  edsEl.addEventListener('mouseup', () => { clearTimeout(t); t = setTimeout(() => {
    const { cm } = activeCM(); if(!cm || !cm.somethingSelected() || !cm.getSelection().trim()){ hideBtn(); return; }
    const c = cm.cursorCoords(cm.getCursor('to'), 'window'); showBtn(c.left, c.bottom);
  }, 120); }, true);
  edsEl.addEventListener('keydown', e => { if(e.altKey && (e.code === 'KeyQ')){ e.preventDefault(); open(); } else if(e.key === 'Escape' && panel){ panel.remove(); panel = null; } else hideBtn(); }, true);
  document.addEventListener('mousedown', e => { if(btn && e.target !== btn) hideBtn(); });
  window.codelabSelExplain = { open };
})();
