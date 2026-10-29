// Ошибки — прямо в коде, а не только в консоли. Три слоя:
//  1) пока пишешь (через паузу): незакрытые и лишние скобки/кавычки (CodeCheck.scanBrackets) и имена-опечатки
//     (/api/code/names) — подчёркнуты, подсказка при наведении;
//  2) после запуска: ошибка браузера или Python — красным то место, где упало, и под строкой объяснение по-русски;
//     и слова не в той раскладке (layout-check.js: соnst, сщтые → const) — с кнопкой «исправить» у курсора;
//  3) парные скобки и совпадения слова у курсора — опции CodeMirror (sandbox.js).
// Надстройка песочницы; события codelab-error / codelab-run-start шлёт sandbox.js.
(function(){
  const box = document.getElementById('sandbox');
  const edsEl = box && box.querySelector('#sbEds');
  if(!edsEl) return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const st = document.createElement('style');
  st.textContent = `
  .cm-bad{background:rgba(255,92,122,.22);border-bottom:2px solid #ff5c7a}
  .cm-typo{text-decoration:underline wavy #ffb454;text-underline-offset:3px}
  .cm-layout{background:rgba(255,180,84,.16);border-bottom:2px dotted #ffb454}
  .cm-fix-bub{z-index:30;margin-top:4px;padding:3px 6px 3px 8px;border:1px solid #ffb454;border-radius:7px;background:var(--bg2,#150a2b);
    font:12px system-ui,sans-serif;color:var(--text2,#cbc2ea);white-space:nowrap;display:flex;gap:6px;align-items:center;box-shadow:0 4px 14px rgba(0,0,0,.45)}
  .cm-fix-bub b{color:#ffb454;font-family:ui-monospace,monospace}
  .cm-fix-bub button{background:none;border:1px solid var(--border,#3a2f55);border-radius:6px;color:var(--text,#eee);font-size:11.5px;padding:1px 7px;cursor:pointer}
  .cm-fix-bub span{color:var(--text3,#9c90c4);font-size:10.5px}
  .cm-warn{text-decoration:underline dotted #ffb454;text-decoration-thickness:2px;text-underline-offset:3px}
  .cm-err-at{background:rgba(255,92,122,.28);border-bottom:2px solid #ff5c7a;border-radius:2px}
  .cm-err-line{background:rgba(255,92,122,.07)}
  .cm-err-box{box-sizing:border-box;width:calc(100% - 12px);min-width:260px;margin:3px 0 6px 4px;padding:6px 9px;border-left:3px solid #ff5c7a;border-radius:0 7px 7px 0;background:rgba(255,92,122,.10);
    font:12.5px/1.45 system-ui,sans-serif;color:var(--text,#f6f4ff);white-space:normal;display:flex;gap:8px;align-items:flex-start}
  .cm-err-box b{color:#ff8fa3;font-weight:600}
  .cm-err-box .h{color:var(--text3,#9c90c4)}
  .cm-err-box .t{flex:1;min-width:0}
  .cm-err-box button{background:none;border:1px solid var(--border,#3a2f55);border-radius:6px;color:var(--text2,#cbc2ea);font-size:11.5px;padding:1px 7px;cursor:pointer;white-space:nowrap}
  `;
  document.head.appendChild(st);

  const edFor = id => { for(const ed of edsEl.children) if(ed.__f && ed.__f.id === id) return ed; return null; };
  const cmOf = ed => { const ta = ed && ed.querySelector('textarea'); return ta && ta.__cm; };
  const langOf = ed => String((ed && ed.__f && ed.__f.lang) || '').toLowerCase();

  // ── 1. пока пишешь ──
  const live = new WeakMap();   // cm → {marks, timer}
  async function check(ed){
    const cm = cmOf(ed); if(!cm) return; const st = live.get(cm); if(!st) return;
    const code = cm.getValue(), lang = langOf(ed), ver = ++st.ver;
    const marks = [];
    if(window.CodeCheck) for(const b of window.CodeCheck.scanBrackets(code, lang).slice(0, 20))
      marks.push({ from: b.from, to: b.to, cls: 'cm-bad', title: b.msg });
    let r = null;
    if(/^(js|ts|javascript|typescript|python|py)$/.test(lang) && code.length < 200000){
      r = await fetch('/api/code/names', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, lang: /^py/.test(lang) ? 'python' : 'js' }) }).then(x => x.ok ? x.json() : null).catch(() => null);
      if(ver !== st.ver) return;   // пока ждали — код уже поменялся
      for(const t of (r && r.typos) || []){
        const line = cm.getLine(t.line) || ''; const re = new RegExp('(^|[^\\wА-Яа-яЁё$])' + t.name.replace(/[$]/g, '\\$') + '(?![\\wА-Яа-яЁё$])', 'g'); let m;
        while((m = re.exec(line))){ const ch = m.index + m[1].length; const a = cm.indexFromPos({ line: t.line, ch });
          marks.push({ from: a, to: a + t.name.length, cls: 'cm-typo', title: (t.kind === 'метод' ? 'такого метода нет — может, ' : 'имя нигде не объявлено — может, ') + t.maybe + '?' }); }
      }
    }
    // раскладка: известные слова — словарь языка, ключевые слова и свои имена файла
    if(window.LayoutCheck && code.length < 200000){
      const known = await knownWords(lang); if(ver !== st.ver) return;
      const all = new Set(known); Object.keys((r && r.names) || {}).forEach(n => all.add(n.toLowerCase()));
      for(const x of window.LayoutCheck.check(code, lang, all)) if(!marks.some(o => o.from < x.to && o.to > x.from))
        marks.push({ from: x.from, to: x.to, cls: 'cm-layout', title: x.why + (x.fix ? ' → ' + x.fix + ' (Alt+Enter — исправить)' : ''), fix: x.fix });
    }
    // правила структуры языка: что внутри чего, что после чего, чего требует (dict/structure.json)
    if(window.StructureRules && code.length < 200000){
      const rules = await structRules(lang); if(ver !== st.ver) return;
      for(const x of window.StructureRules.check(code, lang, rules).slice(0, 40)) if(!marks.some(o => o.from < x.to && o.to > x.from))
        marks.push({ from: x.from, to: x.to, cls: x.level === 'warn' ? 'cm-warn' : 'cm-bad', title: x.msg });
    }
    if(ver !== st.ver) return;
    st.marks.forEach(m => m.clear());
    st.marks = marks.map(k => { const mk = cm.markText(cm.posFromIndex(k.from), cm.posFromIndex(k.to), { className: k.cls, attributes: { title: k.title } }); if(k.fix) mk.__fix = k.fix; return mk; });
    bubble(cm);
  }
  // известные слова языка для проверки раскладки — один раз на язык
  const KW = 'break case catch class const continue default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while yield async await of static get set from as true false null undefined def elif except lambda pass raise with global nonlocal assert is not and or none print self cls len range str int float list dict'.split(' ');
  const knownCache = {};
  function knownWords(lang){
    const l = /^py/.test(lang) ? 'python' : /^(ts|typescript|javascript)$/.test(lang) ? 'js' : lang;
    return knownCache[l] || (knownCache[l] = (window.codelabKwDict ? window.codelabKwDict(l) : Promise.resolve({})).then(d => {
      const set = new Set(KW); const add = o => { if(o) for(const key of Object.keys(o)) for(const m of key.matchAll(/[A-Za-z_$][\w$-]*/g)) set.add(m[0].toLowerCase()); };
      d = d || {}; add(d.words); add(d.langs && d.langs[l]);
      if(l === 'css' || l === 'html'){ add(d.cssProps); add(d.cssVals); add(d.htmlTags); add(d.htmlAttrs); }
      return set;
    }).catch(() => new Set(KW)));
  }
  const canon = lang => /^py/.test(lang) ? 'python' : /^(ts|typescript|javascript|jsx)$/.test(lang) ? 'js' : lang;
  const structCache = {};
  function structRules(lang){
    const l = canon(lang);
    return structCache[l] || (structCache[l] = (window.codelabKwDict ? window.codelabKwDict(l) : Promise.resolve({}))
      .then(d => window.StructureRules.parse(((d && d.structure && d.structure[l]) || []).join('\n')).rules).catch(() => []));
  }
  // Tab после слова с шаблоном «пишется» — раскрыть шаблон с отступом строки; «…» — места для своего:
  // первое выделено, следующий Tab переходит к следующему
  // следующее «…» после курсора в пределах последнего раскрытого шаблона (tpl — {to: номер последней строки})
  function nextSlot(cm, tpl){
    const from = cm.getCursor('to'); if(!tpl || from.line > tpl.to) return false;
    for(let l = from.line; l <= Math.min(tpl.to, cm.lastLine()); l++){ const t = cm.getLine(l); const i = t.indexOf('…', l === from.line ? from.ch : 0); if(i >= 0){ cm.setSelection({ line: l, ch: i }, { line: l, ch: i + 1 }); return true; } }
    return false;
  }
  async function tabTemplate(cm, ed){
    const st = live.get(cm) || {};
    if(cm.somethingSelected()){
      if(cm.getSelection() !== '…') return false;
      if(!nextSlot(cm, st.tpl || { to: cm.getCursor().line + 30 })){ cm.setCursor(cm.getCursor('to')); st.tpl = null; }
      return true;
    }
    const c = cm.getCursor(), line = cm.getLine(c.line), m = line.slice(0, c.ch).match(/[@\wА-Яа-яЁё$-]+$/);
    const rules = m ? await structRules(langOf(ed)) : []; const tpl = m && window.StructureRules.templateFor(m[0], rules);
    // своё уже вписано — Tab ведёт к следующему «…» шаблона
    if(!tpl){ if(nextSlot(cm, st.tpl)) return true; st.tpl = null; return false; }
    const ind = (line.match(/^\s*/) || [''])[0], from = { line: c.line, ch: c.ch - m[0].length };
    cm.replaceRange(tpl.split('\n').map((x, i) => i ? ind + x : x).join('\n'), from, c);
    st.tpl = { to: from.line + tpl.split('\n').length - 1 };
    // первое «…» после начала вставки
    for(let l = from.line; l <= from.line + tpl.split('\n').length; l++){ const t = cm.getLine(l) || ''; const i = t.indexOf('…', l === from.line ? from.ch : 0); if(i >= 0){ cm.setSelection({ line: l, ch: i }, { line: l, ch: i + 1 }); break; } }
    return true;
  }
  // курсор в слове не той раскладки — рядом кнопка «→ const»; Alt+Enter — то же
  const fixAt = cm => { const c = cm.getCursor(); return cm.findMarksAt(c).find(m => m.__fix); };
  function applyFix(cm, mk){ const r = mk && mk.find(); if(!r) return false; cm.replaceRange(mk.__fix, r.from, r.to); return true; }
  function bubble(cm){
    const st = live.get(cm); if(!st) return;
    if(st.bub){ st.bub.remove(); st.bub = null; }
    const mk = fixAt(cm); if(!mk || !cm.hasFocus()) return;
    const r = mk.find(); if(!r) return;
    const el = document.createElement('div'); el.className = 'cm-fix-bub';
    el.innerHTML = 'раскладка → <b>' + esc(mk.__fix) + '</b> <button>исправить</button><span>Alt+Enter</span>';
    el.onmousedown = e => e.preventDefault();
    el.querySelector('button').onclick = () => applyFix(cm, mk);
    cm.addWidget(r.to, el, false); st.bub = el;
  }
  function attach(ed){
    const cm = cmOf(ed); if(!cm || live.has(cm)) return;
    const st = { marks: [], timer: null, ver: 0 }; live.set(cm, st);
    cm.on('cursorActivity', () => bubble(cm));
    cm.on('blur', () => { if(st.bub){ st.bub.remove(); st.bub = null; } });
    cm.on('keydown', (c, e) => {
      // Tab: шаблон не нашёлся — обычный отступ (повторяем то, что делает Tab в песочнице)
      if(e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.defaultPrevented && window.StructureRules){
        e.preventDefault(); tabTemplate(c, ed).then(done => { if(!done){ if(c.somethingSelected()) c.execCommand('indentMore'); else c.execCommand('insertSoftTab'); } }); return; }
      if(e.altKey && e.key === 'Enter'){ const mk = fixAt(c); if(mk){ e.preventDefault(); applyFix(c, mk); } } });
    cm.on('change', () => { clearTimeout(st.timer); st.timer = setTimeout(() => check(ed), 700); clearErr(cm); });
    check(ed);
  }
  edsEl.addEventListener('focusin', e => { const ed = e.target.closest && e.target.closest('.sb-ed'); if(ed) attach(ed); });
  setTimeout(() => { for(const ed of edsEl.children) attach(ed); }, 1500);

  // ── 2. ошибка после запуска: что случилось простыми словами ──
  const RULES = [
    [/^(?:Uncaught )?ReferenceError: (.+) is not defined/, m => ({ tok: m[1], title: 'имя «' + m[1] + '» нигде не объявлено', hint: 'нет const/let/function с таким именем выше по коду — или опечатка' })],
    [/Cannot read propert(?:y|ies) of null \(reading '([^']+)'\)/, m => ({ tok: m[1], title: 'слева от «.' + m[1] + '» пусто (null)', hint: 'обычно элемент не найден: проверь селектор в querySelector и что такой элемент есть в HTML' })],
    [/Cannot read propert(?:y|ies) of undefined \(reading '([^']+)'\)/, m => ({ tok: m[1], title: 'слева от «.' + m[1] + '» ничего нет (undefined)', hint: 'у переменной нет значения или у объекта нет такого поля' })],
    [/Cannot set propert(?:y|ies) of (null|undefined) \(setting '([^']+)'\)/, m => ({ tok: m[2], title: 'некуда записать «.' + m[2] + '»: слева ' + m[1], hint: 'объект, в который пишешь, не найден или пустой' })],
    [/(\S+) is not a function/, m => ({ tok: m[1].split('.').pop().replace(/[()]/g, ''), title: '«' + m[1] + '» — не функция', hint: 'опечатка в имени метода, или в этой переменной лежит значение, а не функция' })],
    [/(\S+) is not iterable/, m => ({ tok: m[1], title: '«' + m[1] + '» нельзя перебрать', hint: 'for…of и … работают со списками и строками, а здесь не список' })],
    [/Assignment to constant variable/, () => ({ title: 'const нельзя переназначить', hint: 'если значение меняется — объяви через let' })],
    [/Identifier '([^']+)' has already been declared/, m => ({ tok: m[1], title: '«' + m[1] + '» объявлено второй раз', hint: 'переименуй или убери второе const/let' })],
    [/Unexpected end of input/, () => ({ title: 'код оборвался', hint: 'не закрыта скобка или кавычка — она подсвечена красным' })],
    [/missing \) after argument list/, () => ({ title: 'не хватает «)»', hint: 'вызов функции не закрыт или между аргументами нет запятой' })],
    [/Unexpected token '?([^'\s]+)'?/, m => ({ tok: m[1], title: 'здесь не ожидалось «' + m[1] + '»', hint: 'лишний знак или пропущен знак перед ним (запятая, скобка, точка с запятой)' })],
    [/Invalid or unexpected token/, () => ({ title: 'непонятный знак', hint: 'обычно незакрытая кавычка или «умная» кавычка «» вместо обычной' })],
    [/Unexpected identifier '?([^'\s]+)'?/, m => ({ tok: m[1], title: 'здесь не ожидалось «' + m[1] + '»', hint: 'пропущен знак перед ним: запятая, точка, скобка или оператор' })],
    // Python
    [/NameError: name '([^']+)' is not defined/, m => ({ tok: m[1], title: 'имя «' + m[1] + '» нигде не объявлено', hint: 'нет присваивания или def с таким именем выше — или опечатка' })],
    [/AttributeError: '([^']+)' object has no attribute '([^']+)'/, m => ({ tok: m[2], title: 'у ' + m[1] + ' нет «.' + m[2] + '»', hint: 'опечатка в имени метода или у этого типа такого нет' })],
    [/IndentationError: (.+)/, () => ({ title: 'отступ не на месте', hint: 'внутри if/for/def строки сдвигаются на 4 пробела, одинаково' })],
    [/SyntaxError: (.+)/, m => ({ title: 'синтаксис: ' + m[1], hint: 'чаще всего забыто «:» в конце if/for/def или не закрыта скобка' })],
    [/ZeroDivisionError/, () => ({ tok: '/', title: 'деление на ноль', hint: 'проверь, что делитель не 0' })],
    [/IndexError: (.+)/, () => ({ tok: '[', title: 'такого номера в списке нет', hint: 'номера с 0, последний — len(список) - 1' })],
    [/KeyError: '?([^']+)'?/, m => ({ tok: m[1], title: 'в словаре нет ключа «' + m[1] + '»', hint: 'проверь написание ключа или бери через .get(ключ)' })],
    [/TypeError: (.+)/, m => ({ title: 'не тот тип: ' + m[1], hint: 'складываешь или вызываешь не то: например, строку с числом' })],
  ];
  const explain = msg => { for(const [re, f] of RULES){ const m = String(msg).match(re); if(m) return f(m); } return { title: String(msg).replace(/^Uncaught /, ''), hint: '' }; };

  const errs = new WeakMap();   // cm → [mark, widget, lineHandle]
  function clearErr(cm){ const e = errs.get(cm); if(!e) return; e.forEach(x => { try { x.clear ? x.clear() : cm.removeLineClass(x, 'background', 'cm-err-line'); } catch(_){} }); errs.delete(cm); }
  window.addEventListener('codelab-run-start', () => { for(const ed of edsEl.children){ const cm = cmOf(ed); if(cm) clearErr(cm); } });
  window.addEventListener('codelab-error', async e => {
    const { id, line, col, msg } = e.detail || {}; const ed = edFor(id); const cm = cmOf(ed); if(!cm || line < 0 || line >= cm.lineCount()) return;
    if(errs.has(cm)) return;   // первая ошибка — главная, остальные часто её следствие
    const x = explain(msg); const text = cm.getLine(line);
    // что подсветить: слово из сообщения ближе всего к столбцу ошибки; иначе слово под столбцом; иначе всю строку
    let a = -1, b = -1;
    if(x.tok){ let best = -1, i = -1; while((i = text.indexOf(x.tok, i + 1)) >= 0){ if(best < 0 || Math.abs(i - col) < Math.abs(best - col)) best = i; } if(best >= 0){ a = best; b = best + x.tok.length; } }
    if(a < 0 && col >= 0 && col < text.length){ a = col; b = col; const re = /[\wА-Яа-яЁё$]/; while(a > 0 && re.test(text[a - 1])) a--; while(b < text.length && re.test(text[b])) b++; if(a === b) b = a + 1; }
    if(a < 0){ a = text.search(/\S/); b = text.length; if(a < 0) a = 0; }
    const out = [cm.markText({ line, ch: a }, { line, ch: b }, { className: 'cm-err-at', attributes: { title: x.title } })];
    out.push(cm.addLineClass(line, 'background', 'cm-err-line'));
    errs.set(cm, out);   // занять сразу: пока ждём подсказку, такая же ошибка от повторного запуска не дублирует рамку
    // имя не объявлено — подскажем похожее (те же данные, что у «что это?»)
    let fix = null;
    if(/не объявлено/.test(x.title) && x.tok){ const lang = langOf(ed);
      const r = await fetch('/api/code/names', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: cm.getValue(), lang: /^py/.test(lang) ? 'python' : 'js' }) }).then(q => q.ok ? q.json() : null).catch(() => null);
      const t = r && r.typos.find(y => y.name === x.tok); if(t) fix = t.maybe; }
    if(errs.get(cm) !== out) return;   // пока ждали — запустили снова или поправили код
    const box = document.createElement('div'); box.className = 'cm-err-box';
    box.innerHTML = '<span class="t"><b>' + esc(x.title) + '</b>' + (fix ? ' — может, <b>' + esc(fix) + '</b>?' : '') + (x.hint ? '<br><span class="h">' + esc(x.hint) + '</span>' : '') + '</span>'
      + (fix ? '<button data-fix>исправить</button>' : '') + '<button data-x title="скрыть">×</button>';
    box.querySelector('[data-x]').onclick = () => clearErr(cm);
    const fb = box.querySelector('[data-fix]'); if(fb) fb.onclick = () => { const l = cm.getLine(line); cm.replaceRange(l.slice(0, a) + fix + l.slice(b), { line, ch: 0 }, { line, ch: l.length }); };
    out.push(cm.addLineWidget(line, box, { noHScroll: true }));
    // ошибка в другой вкладке — переключиться туда и показать строку
    try { if(window.codelabTabs && localStorage.getItem('codelab_sb_active') !== id) window.codelabTabs.setActive(id); } catch(_){}
    cm.scrollIntoView({ line, ch: a }, 80);
  });
  window.codelabCodeMarks = { explain };
})();
