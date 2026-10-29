// Правила структуры: что внутри чего, что после чего, что чего требует и как пишется. Строка = правило:
//   li: внутри ul, ol                     p: не содержит div, ul        summary: первым в details
//   elif: после if, elif                  gap: требует display: flex | grid
//   if: пишется if (…) {\n  …\n}         id: связывает css #*, js getElementById('*')
//   img: обязательно src                  img: можно alt, width, loading     *: можно id, class, title (общие)
//   button[type]: значения button, submit, reset
// После « — » можно оставить пояснение. Правила лежат в dict/structure.json по языкам и правятся в Описи.
// parse — разбор текста; check — нарушения в коде; templateFor — шаблон «пишется». Общий для страницы и тестов.
(function(root){
  'use strict';
  const VERBS = ['не внутри', 'внутри', 'не содержит', 'содержит', 'первым в', 'после', 'требует', 'пишется', 'связывает', 'читает', 'обязательно', 'можно', 'значения', 'заметка'];
  const VOID = new Set('area base br col embed hr img input link meta source track wbr'.split(' '));

  // как ИИ и люди называют те же правила другими словами — приводим к своим (длинные фразы проверяются раньше)
  const ALIAS = [
    ['не может содержать', 'не содержит'], ['не должен содержать', 'не содержит'], ['не должно содержать', 'не содержит'],
    ['не может быть внутри', 'не внутри'], ['не может стоять внутри', 'не внутри'], ['нельзя внутри', 'не внутри'], ['не бывает внутри', 'не внутри'], ['запрещено внутри', 'не внутри'],
    ['должен быть первым в', 'первым в'], ['должен идти первым в', 'первым в'], ['идёт первым в', 'первым в'], ['идет первым в', 'первым в'], ['первый в', 'первым в'], ['первым внутри', 'первым в'],
    ['должен быть внутри', 'внутри'], ['должно быть внутри', 'внутри'], ['должна быть внутри', 'внутри'], ['только внутри', 'внутри'], ['стоит внутри', 'внутри'], ['живёт внутри', 'внутри'], ['живет внутри', 'внутри'], ['бывает внутри', 'внутри'], ['находится внутри', 'внутри'],
    ['может содержать', 'содержит'], ['содержит в себе', 'содержит'], ['внутри лежат', 'содержит'], ['внутри бывают', 'содержит'],
    ['идёт после', 'после'], ['идет после', 'после'], ['только после', 'после'], ['следует за', 'после'], ['сразу после', 'после'],
    ['работает только с', 'требует'], ['зависит от', 'требует'], ['нужен', 'требует'], ['нужна', 'требует'], ['нужно', 'требует'],
    ['записывается', 'пишется'], ['шаблон', 'пишется'], ['синтаксис', 'пишется'], ['пишут', 'пишется'], ['форма', 'пишется'], ['пример', 'пишется'],
    ['обязательные атрибуты', 'обязательно'], ['обязательные параметры', 'обязательно'], ['обязательные', 'обязательно'], ['обязательный', 'обязательно'], ['обязателен', 'обязательно'], ['обязательна', 'обязательно'], ['обязательны', 'обязательно'], ['требуется', 'обязательно'], ['required', 'обязательно'],
    ['необязательные атрибуты', 'можно'], ['необязательные параметры', 'можно'], ['необязательные', 'можно'], ['необязательно', 'можно'], ['опционально', 'можно'], ['может иметь', 'можно'], ['атрибуты', 'можно'], ['параметры', 'можно'], ['optional', 'можно'],
    ['допустимые значения', 'значения'], ['возможные значения', 'значения'], ['принимает значения', 'значения'], ['принимает', 'значения'], ['значение', 'значения'], ['варианты', 'значения'],
    ['применяется к', 'связывает'], ['применяется для', 'связывает'], ['относится к', 'связывает'], ['используется в', 'связывает'], ['используется с', 'связывает'],
    ['связан с', 'связывает'], ['связано с', 'связывает'], ['связана с', 'связывает'], ['читается', 'читает'], ['читают', 'читает'],
  ];
  // вид правила в начале текста: свой или синоним → {verb, len}
  function verbAt(rest){
    const r = rest.toLowerCase().replace(/ё/g, 'е'), ok = (w, n) => r.startsWith(w.replace(/ё/g, 'е')) && (r.length === n || /[\s:]/.test(r[n]));
    for(const v of VERBS) if(ok(v, v.length)) return { verb: v, len: v.length };
    for(const [a, v] of ALIAS) if(ok(a, a.length)) return { verb: v, len: a.length };
    return null;
  }
  function parse(text){
    const rules = [], bad = [];
    String(text || '').split(/\r?\n/).forEach((raw, i) => {
      // пункты списков и нумерация из ответа ИИ, `обратные кавычки` вокруг слова
      let line = raw.trim().replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, '').trim(); if(!line || line.startsWith('#') || line.startsWith('//')) return;
      line = line.replace(/^`([^`]+)`(\s*:)/, '$1$2');
      // в самом слове бывает «:» (a:hover, ::before, std::vector) — делим по тому «:», после которого стоит вид правила
      let term = '', rest = '', hit = null;
      for(let k = line.indexOf(':'); k >= 0; k = line.indexOf(':', k + 1)){
        const t = line.slice(0, k).trim(), r = line.slice(k + 1).trim(); if(!t) continue;
        if(/^(удалить|-)$/i.test(r)){ term = t; rest = r; hit = { verb: 'удалить', len: r.length }; break; }
        const v = verbAt(r); if(v){ term = t; rest = r; hit = v; break; }
      }
      if(!hit){
        if(!/:/.test(line)){ bad.push({ line: i + 1, text: line, why: 'нет «:» — нужно «слово: правило»' }); return; }
        // «слово: просто текст» — не правило, а пояснение (pre: сохраняет пробелы…): храним заметкой, проверок по ней нет
        const k = line.indexOf(':'), t = line.slice(0, k).trim(), r = line.slice(k + 1).trim();
        if(t && r && /[А-Яа-яЁё]/.test(r) && !/\s/.test(t.replace(/\[[^\]]*\]/g, ''))){ rules.push({ term: t, verb: 'заметка', args: [r], note: '', raw: t + ': заметка ' + r, guessed: true }); return; }
        bad.push({ line: i + 1, text: line, why: 'неизвестное правило — можно: ' + VERBS.join(', ') });
        return;
      }
      if(hit.verb === 'удалить'){ rules.push({ term, verb: 'удалить', args: [], raw: term + ': удалить' }); return; }
      const verb = hit.verb; rest = rest.slice(hit.len).replace(/^\s*:?\s*/, '');
      // пояснение после « — » (в шаблоне тире может быть частью кода — там не режем)
      let note = '';
      if(verb === 'пишется'){
        // шаблон в `обратных кавычках` — берём код из первых кавычек, остальное (« — пояснение», «или …») в пояснение
        const bq = rest.match(/^`([^`]+)`\s*(.*)$/);
        if(bq){ rest = bq[1]; note = bq[2].replace(/^[—–-]\s*/, '').trim(); }
        else { const k = rest.search(/\s[—–]\s+[А-Яа-яЁё]/); if(k >= 0){ note = rest.slice(k).replace(/^\s*[—–]\s*/, '').trim(); rest = rest.slice(0, k).trim(); } }
      } else if(verb !== 'заметка'){
        const k = rest.search(/\s[—–]\s|\s-\s/); if(k >= 0){ note = rest.slice(k).replace(/^\s*[—–-]\s*/, '').trim(); rest = rest.slice(0, k).trim(); }
        rest = rest.replace(/\.$/, '').replace(/`/g, '');
      }
      if(!rest){ bad.push({ line: i + 1, text: line, why: 'после «' + verb + '» ничего не указано' }); return; }
      const args = verb === 'пишется' || verb === 'требует' || verb === 'заметка' ? [rest] : rest.split(/\s*[,|;]\s*|\s+или\s+/).map(s => s.trim()).filter(Boolean);
      // строка храним в своём виде: синонимы и разметка ИИ не попадают в файл
      rules.push({ term, verb, args, note, raw: term + ': ' + verb + ' ' + (verb === 'пишется' || verb === 'требует' || verb === 'заметка' ? rest : args.join(', ')) + (note ? ' — ' + note : '') });
    });
    return { rules, bad };
  }
  // описательное правило — сохраняется и показывается, но не проверяется: ИИ пишет «внутри потокового содержимого»,
  // «обязательно один элемент на документ», «значения: совпадает с id…»; а «внутри body, div, main…» — это обычные
  // места, а не ограничение (настоящее — li: внутри ul, ol; td: внутри tr)
  const prose = a => /[А-Яа-яЁё]/.test(a) || /\s/.test(String(a).trim());
  const FLOW = new Set(['body', 'div', 'main', 'section', 'article', 'p', 'span', 'form', 'li', 'td']);
  function inert(r){
    if(['заметка', 'пишется', 'связывает', 'читает', 'удалить'].includes(r.verb)) return false;
    if(r.verb === 'требует') return /[А-Яа-яЁё]/.test(r.args[0] || '');
    // «внутри A, где угодно ещё» — список неполный, проверять нечего; в остальных списках описание просто отбрасывается
    if(r.verb === 'внутри') return r.args.some(prose) || r.args.some(a => FLOW.has(String(a).toLowerCase()));
    return r.args.every(prose);
  }
  const byTerm = (rules, verb) => { const m = new Map(); for(const r of rules || []) if(r.verb === verb && !inert(r)){ const k = r.term.toLowerCase(); const x = r.verb === 'требует' ? r : Object.assign({}, r, { args: r.args.filter(a => !prose(a)) }); m.set(k, (m.get(k) || []).concat(x)); } return m; };

  // строки и комментарии — пробелами (позиции сохраняются)
  function blank(code, lang){
    const s = String(code || ''), sp = m => m.replace(/[^\n]/g, ' ');
    if(lang === 'html') return s.replace(/<!--[\s\S]*?-->/g, sp).replace(/(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2>)/gi, (m, a, t, b, c) => a + sp(b) + c);
    const hash = /^(python|py|bash|sh|ruby|yaml)$/.test(lang);
    const re = hash ? /#[^\n]*|'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g
      : lang === 'css' ? /\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g
      : /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g;
    return s.replace(re, sp);
  }
  const listText = a => a.map(x => '<' + x + '>').join(', ');

  // HTML: стек открытых тегов → внутри / не внутри / не содержит / первым в + теги, закрытые не той парой
  function checkHtml(code, rules){
    const b = blank(code, 'html'), out = [];
    const IN = byTerm(rules, 'внутри'), NOTIN = byTerm(rules, 'не внутри'), NOTHAS = byTerm(rules, 'не содержит'), FIRST = byTerm(rules, 'первым в');
    const stack = [];   // {name, from, kids}
    for(const m of b.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g)){
      const close = !!m[1], name = m[2].toLowerCase(), from = m.index + 1 + m[1].length, to = from + m[2].length;
      if(close){
        const i = stack.map(x => x.name).lastIndexOf(name);
        if(i < 0){ out.push({ from, to, msg: '</' + name + '> закрывает то, что не открывали', level: 'bad' }); continue; }
        for(let j = stack.length - 1; j > i; j--) if(!VOID.has(stack[j].name)) out.push({ from: stack[j].from, to: stack[j].from + stack[j].name.length, msg: '<' + stack[j].name + '> не закрыт до </' + name + '>', level: 'bad' });
        stack.length = i; continue;
      }
      checkAttrs(name, m[0], m.index, rules, out);
      const parent = stack[stack.length - 1], anc = stack.map(x => x.name);
      for(const r of IN.get(name) || []) if(!parent || !r.args.map(x => x.toLowerCase()).includes(parent.name)) out.push({ from, to, msg: '<' + name + '> должен быть внутри ' + listText(r.args) + (r.note ? ' — ' + r.note : ''), level: 'bad' });
      for(const r of NOTIN.get(name) || []){ const hit = anc.find(a => r.args.map(x => x.toLowerCase()).includes(a)); if(hit) out.push({ from, to, msg: '<' + name + '> нельзя внутри <' + hit + '>' + (r.note ? ' — ' + r.note : ''), level: 'bad' }); }
      for(const a of stack) for(const r of NOTHAS.get(a.name) || []) if(r.args.map(x => x.toLowerCase()).includes(name)) out.push({ from, to, msg: '<' + a.name + '> не может содержать <' + name + '>' + (r.note ? ' — ' + r.note : ''), level: 'bad' });
      for(const r of FIRST.get(name) || []) if(parent && r.args.map(x => x.toLowerCase()).includes(parent.name) && parent.kids > 0) out.push({ from, to, msg: '<' + name + '> должен идти первым в <' + parent.name + '>', level: 'warn' });
      if(parent) parent.kids++;
      if(!VOID.has(name) && !m[3]) stack.push({ name, from, kids: 0 });
    }
    for(const s of stack) if(!/^(html|head|body|p|li|td|th|tr|option|dt|dd)$/.test(s.name)) out.push({ from: s.from, to: s.from + s.name.length, msg: '<' + s.name + '> не закрыт — нет </' + s.name + '>', level: 'bad' });
    return out;
  }

  // атрибуты тега по правилам: обязательно / можно / общие (* : можно …) / значения (тег[атрибут] или *[атрибут])
  function attrsFor(tag, rules){
    const t = String(tag).toLowerCase(), pick = (term, verb) => (rules || []).filter(r => r.verb === verb && r.term.toLowerCase() === term).flatMap(r => r.args.filter(a => !prose(a)).map(a => ({ name: a, note: r.note })));
    const required = pick(t, 'обязательно'), optional = pick(t, 'можно'), global = pick('*', 'можно');
    const values = attr => { const a = String(attr).toLowerCase(); if(a === '') { const own = (rules || []).find(x => x.verb === 'значения' && x.term.toLowerCase() === t && !x.args.some(prose)); return own ? { list: own.args, note: own.note } : null; } const r = (rules || []).find(x => x.verb === 'значения' && !x.args.some(prose) && (x.term.toLowerCase() === t + '[' + a + ']')) || (rules || []).find(x => x.verb === 'значения' && !x.args.some(prose) && x.term.toLowerCase() === '*[' + a + ']'); return r ? { list: r.args, note: r.note } : null; };
    return { required, optional, global, values, known: required.length + optional.length > 0 };
  }
  const near1 = (a, b) => { if(Math.abs(a.length - b.length) > 1) return false; let i = 0, j = 0, e = 0; while(i < a.length && j < b.length){ if(a[i] === b[j]){ i++; j++; continue; } if(++e > 1) return false;
    if(a[i + 1] === b[j] && a[i] === b[j + 1]){ i += 2; j += 2; continue; } if(a.length > b.length) i++; else if(b.length > a.length) j++; else { i++; j++; } } return e + (a.length - i) + (b.length - j) <= 1; };
  function checkAttrs(tag, text, at, rules, out){
    const A = attrsFor(tag, rules); if(!A.known && !A.global.length) return;
    const attrs = [...text.matchAll(/\s([^\s=\/>"']+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)].map(m => ({ name: m[1].toLowerCase(), raw: m[1], val: m[2] ? m[2].replace(/^["']|["']$/g, '') : null, from: at + m.index + 1 }));
    const tagFrom = at + 1, tagTo = tagFrom + tag.length;
    for(const r of A.required) if(!attrs.some(x => x.name === r.name.toLowerCase())) out.push({ from: tagFrom, to: tagTo, msg: '<' + tag + '> без ' + r.name + (r.note ? ' — ' + r.note : ' не заработает'), level: 'warn' });
    const okNames = A.required.concat(A.optional, A.global).map(x => x.name.toLowerCase());
    for(const x of attrs){
      if(/^(data-|aria-|on)/.test(x.name) || okNames.includes(x.name)){
        const v = x.val != null && A.values(x.name);
        if(v && x.val !== '' && !v.list.map(y => y.toLowerCase()).includes(x.val.toLowerCase()) && !/[…{}$]/.test(x.val)) out.push({ from: x.from, to: x.from + x.raw.length, msg: x.raw + '="' + x.val + '" — бывает: ' + v.list.join(', ') + (v.note ? ' — ' + v.note : ''), level: 'warn' });
        continue;
      }
      // незнакомое имя, похожее на известное, — скорее опечатка (srс, atl, tpye); просто незнакомое не трогаем
      const like = okNames.find(n => near1(x.name, n)); if(like && A.known) out.push({ from: x.from, to: x.from + x.raw.length, msg: 'у <' + tag + '> нет атрибута «' + x.raw + '» — может, ' + like + '?', level: 'bad' });
    }
  }

  // CSS: «требует» — в том же правиле (или в другом правиле с тем же селектором) должно быть нужное свойство
  function checkCss(code, rules){
    const b = blank(code, 'css'), out = [], REQ = byTerm(rules, 'требует'), VAL = byTerm(rules, 'значения');
    cssShape(b, out);
    const blocks = [];
    for(const m of b.matchAll(/([^{}]*)\{([^{}]*)\}/g)){
      const sel = m[1].trim().replace(/\s+/g, ' '), body = m[2], at = m.index + m[1].length + 1;
      const decls = [...body.matchAll(/([\w-]+)\s*:\s*([^;]*)/g)].map(d => ({ prop: d[1].toLowerCase(), val: d[2].trim().toLowerCase(), from: at + d.index }));
      blocks.push({ sel, decls });
    }
    // значение-слово, на одну правку похожее на допустимое, — опечатка (flx → flex); прочие значения (длины, var()) не трогаем
    for(const bl of blocks) for(const d of bl.decls) for(const r of VAL.get(d.prop) || []){
      const v = d.val.replace(/\s*!important$/, ''); if(!/^[a-z-]+$/.test(v)) continue;
      const list = r.args.map(x => x.toLowerCase()); if(list.includes(v)) continue;
      const like = list.find(x => near1(v, x)); if(like){ const at = d.from + b.slice(d.from).indexOf(d.val, d.prop.length); out.push({ from: at, to: at + v.length, msg: d.prop + ': «' + v + '» — может, ' + like + '?', level: 'bad' }); }
    }
    for(const bl of blocks) for(const d of bl.decls) for(const r of REQ.get(d.prop) || []){
      const need = r.args[0].match(/^([\w-]+)\s*(?::\s*(.+))?$/); if(!need) continue;
      const np = need[1].toLowerCase(), vals = need[2] ? need[2].split(/\s*\|\s*|\s+или\s+/).map(v => v.trim().toLowerCase()) : null;
      const has = blocks.filter(x => x.sel === bl.sel).some(x => x.decls.some(y => y.prop === np && (!vals || vals.some(v => y.val.split(/\s+/).includes(v)))));
      if(!has) out.push({ from: d.from, to: d.from + d.prop.length, msg: d.prop + ' не сработает без ' + np + (vals ? ': ' + vals.join(' или ') : '') + ' у «' + bl.sel + '»' + (r.note ? ' — ' + r.note : ''), level: 'warn' });
    }
    return out;
  }

  // форма CSS внутри { }: свойство без «:», объявление без «;» перед следующим (они склеятся в одно)
  function cssShape(b, out){
    let depth = 0, pos = 0; const lines = b.split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if(depth > 0 && t && !/[{}]/.test(t) && !t.startsWith('@')){
        const m = line.match(/^(\s*)([a-z-]+)(\s+)([^:;]+);?\s*$/i);
        if(m && !/^--/.test(m[2]) && !/[&>+~.#\[]/.test(m[4])) out.push({ from: pos + m[1].length + m[2].length, to: pos + m[1].length + m[2].length + m[3].length, msg: 'после «' + m[2] + '» нужно «:» — свойство: значение;', level: 'bad' });
        const next = lines.slice(i + 1).find(x => x.trim());
        if(/^\s*[a-z-]+\s*:[^;{}]*[^;{}\s,]\s*$/i.test(line) && next && /^\s*[a-z-]+\s*:/i.test(next)){ const e = pos + line.replace(/\s+$/, '').length; out.push({ from: e - 1, to: e, msg: 'в конце нет «;» — следующее свойство склеится с этим', level: 'bad' }); }
      }
      for(const c of line){ if(c === '{') depth++; else if(c === '}') depth = Math.max(0, depth - 1); }
      pos += line.length + 1;
    });
  }

  // форма из шаблона «пишется»: «if (…) {» → после if нужны круглые скобки; «if …:» (Python) → строка кончается «:»
  function codeShape(b, lang, rules, out){
    const py = /^(python|py)$/.test(lang); let pos = 0;
    const tpl = new Map(); for(const r of rules) if(r.verb === 'пишется'){ const first = r.args[0].split('\\n')[0].trim(); tpl.set(r.term.toLowerCase(), first); }
    for(const line of b.split('\n')){
      const m = line.match(/^(\s*\}?\s*)([A-Za-z_]+)\b(.*)$/);
      if(m){ const w = m[2].toLowerCase(), t = tpl.get(w), rest = m[3];
        if(t && t.toLowerCase().startsWith(w)){
          const after = t.slice(w.length);
          const from = pos + m[1].length, to = from + m[2].length;
          if(!py && /^\s*\(/.test(after) && rest.trim() && !/^\s*\(/.test(rest) && !/^\s*[.=:,;)]/.test(rest) && !/^\s*await\b/.test(rest)) out.push({ from, to, msg: 'после ' + m[2] + ' нужны круглые скобки: ' + t.replace(/\s*\{.*$/, ''), level: 'bad' });
          if(py && /:\s*$/.test(t) && !rest.includes(':') && !/[\\(\[{,]\s*$/.test(line.trimEnd()) && !/^\s*[.=(\[]/.test(rest)) out.push({ from, to, msg: 'в конце строки с ' + m[2] + ' нужно «:» — ' + t, level: 'bad' });
        }
      }
      pos += line.length + 1;
    }
  }

  // JS/Python и прочий код: «внутри» — среди заголовков блоков вокруг есть нужное слово; «после» — предыдущий
  // блок того же уровня начинался с нужного слова. Блоки — по { } или по отступам (Python)
  function checkCode(code, lang, rules){
    const IN = byTerm(rules, 'внутри'), NOTIN = byTerm(rules, 'не внутри'), AFTER = byTerm(rules, 'после');
    const b = blank(code, lang), lines = b.split('\n'), out = [];
    codeShape(b, lang, rules, out);
    if(!IN.size && !AFTER.size && !NOTIN.size) return out;
    const py = /^(python|py)$/.test(lang);
    const words = s => (String(s).match(/[A-Za-zА-Яа-яЁё_$][\wА-Яа-яЁё$]*/g) || []).map(w => w.toLowerCase());
    const first = s => words(s.replace(/^[\s}]*/, ''))[0] || '';
    let pos = 0; const stack = [];   // {head, depth|indent}
    const lastClosed = {};           // уровень → заголовок блока, который только что закрылся
    let depth = 0; const prevAt = {};   // Python: отступ → первое слово предыдущей строки этого уровня
    const closeOne = () => { const s = stack.pop(); depth = Math.max(0, depth - 1); if(s) lastClosed[depth] = first(s.head); };
    lines.forEach((line, li) => {
      const ind = (line.match(/^\s*/) || [''])[0].replace(/\t/g, '    ').length, text = line.trim();
      if(py && text){ while(stack.length && stack[stack.length - 1].indent >= ind) stack.pop(); }
      // «} else {»: сначала закрываем блок слева, чтобы else видел только что закрытый if
      const lead = py ? 0 : ((line.match(/^\s*}+/) || [''])[0]).length; let headFrom = lead;
      if(!py) for(const c of line.slice(0, lead)) if(c === '}') closeOne();
      const fw = first(line);
      // слова и скобки строки по порядку: в «async function h(){ await g(); }» await видит заголовок той же строки
      const ev = []; if(text) for(const m of line.matchAll(/[A-Za-zА-Яа-яЁё_$][\wА-Яа-яЁё$]*|[{}]/g)) ev.push(m);
      for(const m of ev){
        if(!py && m.index >= lead && (m[0] === '{' || m[0] === '}')){
          if(m[0] === '{'){ let head = line.slice(headFrom, m.index); if(!head.trim() && li > 0) head = lines[li - 1]; stack.push({ head }); depth++; headFrom = m.index + 1; }
          else { closeOne(); headFrom = m.index + 1; }
          continue;
        }
        if(m[0] === '{' || m[0] === '}') continue;
        const heads = stack.map(x => x.head);
        const w = m[0].toLowerCase(), from = pos + m.index, to = from + m[0].length;
        if(line[m.index - 1] === '.') continue;
        const hit = need => heads.some(h => need.some(n => /^[\wА-Яа-яЁё$*]+$/.test(n) ? words(h).includes(n.replace(/\*$/, '')) && (!n.endsWith('*') || /function\s*\*/.test(h)) : h.includes(n)));
        for(const r of IN.get(w) || []){ if(!hit(r.args.map(x => x.toLowerCase())))
          out.push({ from, to, msg: m[0] + ' работает только внутри ' + r.args.join(' / ') + (r.note ? ' — ' + r.note : ''), level: 'bad' }); }
        for(const r of NOTIN.get(w) || []){ if(hit(r.args.map(x => x.toLowerCase())))
          out.push({ from, to, msg: m[0] + ' нельзя внутри ' + r.args.join(' / ') + (r.note ? ' — ' + r.note : ''), level: 'bad' }); }
        if(w === fw && AFTER.has(w)){
          const prev = py ? prevAt[ind] : lastClosed[depth];
          for(const r of AFTER.get(w)){ const need = r.args.map(x => x.toLowerCase());
            if(!prev || !need.includes(prev)) out.push({ from, to, msg: m[0] + ' идёт только после ' + r.args.join(' / ') + (r.note ? ' — ' + r.note : ''), level: 'bad' }); }
          // связка использована: дальше на этой строке «после» уже не про прошлый блок
          if(!py) lastClosed[depth] = '';
        }
      }
      if(py){ if(text){ prevAt[ind] = fw; for(const k of Object.keys(prevAt)) if(+k > ind) delete prevAt[k]; if(/:\s*$/.test(text)) stack.push({ head: text, indent: ind }); } }
      else if(text.slice(lead - (line.length - line.trimStart().length)).trim() && !AFTER.has(fw) && !/^[{}]/.test(text.slice(lead - (line.length - line.trimStart().length)).trim())){
        // обычная строка между блоками — связка «после» с прошлым блоком рвётся (если сама строка блок не закрыла)
        if(!/}\s*$/.test(text)) lastClosed[depth] = '';
      }
      pos += line.length + 1;
    });
    return out;
  }

  function check(code, lang, rules){
    const L = String(lang || '').toLowerCase();
    if(!rules || !rules.length) return [];
    if(L === 'html' || L === 'svg') return checkHtml(code, rules);
    if(L === 'css') return checkCss(code, rules);
    return checkCode(code, L, rules);
  }
  // шаблон «пишется»: \n — перенос, «…» — место для своего; первое «…» — куда встанет курсор
  function templateFor(term, rules){
    const r = (rules || []).find(x => x.verb === 'пишется' && x.term.toLowerCase() === String(term).toLowerCase());
    return r ? r.args[0].replace(/\\n/g, '\n').replace(/\\t/g, '  ') : null;
  }
  // короткое «где стоит / чего требует / как пишется» для подписи в «что это?»
  function describe(term, rules){
    const t = String(term).toLowerCase(), out = [];
    for(const r of rules || []) if(r.term.toLowerCase() === t && r.verb !== 'удалить') out.push(r.verb + ' ' + (r.verb === 'пишется' ? r.args[0].replace(/\\n/g, ' ') : r.args.join(', ')));
    return out;
  }

  // дописать правила к строкам языка. Повтор того же ничего не меняет. «обязательно»/«можно» — новые пункты отдельной
  // строкой (у каждой своё пояснение); прочие списки (внутри, после, значения…) — новые пункты в ту же строку; ничего
  // не стирается. «пишется» и «требует» — одно значение, заменяется. «слово: удалить» снимает все правила слова.
  const LIST = new Set(['обязательно', 'можно']);
  const UNION = new Set(['внутри', 'не внутри', 'содержит', 'не содержит', 'первым в', 'после', 'значения', 'связывает', 'читает']);
  function merge(lines, text){
    const { rules, bad } = parse(text); lines = (lines || []).slice();
    let added = 0, replaced = 0, removed = 0, same = 0;
    const lc = x => String(x).toLowerCase();
    for(const r of rules){
      const cur = lines.map(l => ({ l, r: parse(l).rules[0] })).filter(x => x.r);
      // «img: удалить» снимает и значения его атрибутов (img[loading]: …)
      const mine = cur.filter(x => r.verb === 'удалить' ? (lc(x.r.term) === lc(r.term) || lc(x.r.term).startsWith(lc(r.term) + '[')) : lc(x.r.term) === lc(r.term) && x.r.verb === r.verb);
      if(r.verb === 'удалить'){ lines = lines.filter(l => !mine.some(x => x.l === l)); removed += mine.length; continue; }
      if(LIST.has(r.verb)){
        const have = new Set(mine.flatMap(x => x.r.args.map(lc)));
        const fresh = r.args.filter(a => !have.has(lc(a)));
        if(!fresh.length){ same++; continue; }
        lines.push(r.term + ': ' + r.verb + ' ' + fresh.join(', ') + (r.note ? ' — ' + r.note : '')); added++; continue;
      }
      // остальные списки (внутри, после, значения…) — новые пункты дописываются в ту же строку: проверка читает строку целиком
      if(UNION.has(r.verb) && mine.length){
        const x = mine[0], have = new Set(x.r.args.map(lc)), fresh = r.args.filter(a => !have.has(lc(a)));
        if(!fresh.length && (!r.note || r.note === x.r.note)){ same++; continue; }
        const args = x.r.args.concat(fresh), note = r.note || x.r.note || '';
        lines[lines.indexOf(x.l)] = x.r.term + ': ' + x.r.verb + ' ' + args.join(', ') + (note ? ' — ' + note : ''); replaced++; continue;
      }
      if(mine.length){
        if(mine.some(x => x.r.args.map(lc).join('\u0000') === r.args.map(lc).join('\u0000') && (x.r.note || '') === (r.note || ''))){ same++; continue; }
        lines[lines.indexOf(mine[0].l)] = r.raw; replaced++; continue;
      }
      lines.push(r.raw); added++;
    }
    return { lines, added, replaced, removed, same, bad };
  }

  const api = { VERBS, parse, check, templateFor, describe, blank, attrsFor, merge, inert };
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StructureRules = api;
})(typeof self !== 'undefined' ? self : this);
