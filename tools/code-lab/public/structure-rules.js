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
  const VERBS = ['не внутри', 'внутри', 'не содержит', 'содержит', 'первым в', 'после', 'требует', 'пишется', 'связывает', 'читает', 'обязательно', 'можно', 'значения'];
  const VOID = new Set('area base br col embed hr img input link meta source track wbr'.split(' '));

  function parse(text){
    const rules = [], bad = [];
    String(text || '').split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim(); if(!line || line.startsWith('#') || line.startsWith('//')) return;
      const m = line.match(/^(.+?)\s*:\s*(.+)$/); if(!m){ bad.push({ line: i + 1, text: line, why: 'нет «:» — нужно «слово: правило»' }); return; }
      const term = m[1].trim(); let rest = m[2].trim();
      if(/^(удалить|-)$/i.test(rest)){ rules.push({ term, verb: 'удалить', args: [], raw: line }); return; }
      const verb = VERBS.find(v => rest.toLowerCase().startsWith(v + ' ') || rest.toLowerCase() === v);
      if(!verb){ bad.push({ line: i + 1, text: line, why: 'неизвестное правило — можно: ' + VERBS.join(', ') }); return; }
      rest = rest.slice(verb.length).trim();
      // пояснение после « — » (в шаблоне тире может быть частью кода — там не режем)
      let note = ''; if(verb !== 'пишется'){ const k = rest.indexOf(' — '); if(k >= 0){ note = rest.slice(k + 3).trim(); rest = rest.slice(0, k).trim(); } }
      if(!rest){ bad.push({ line: i + 1, text: line, why: 'после «' + verb + '» ничего не указано' }); return; }
      const args = verb === 'пишется' ? [rest] : verb === 'требует' ? [rest] : rest.split(/\s*[,|]\s*|\s+или\s+/).map(s => s.trim()).filter(Boolean);
      rules.push({ term, verb, args, note, raw: line });
    });
    return { rules, bad };
  }
  const byTerm = (rules, verb) => { const m = new Map(); for(const r of rules || []) if(r.verb === verb){ const k = r.term.toLowerCase(); m.set(k, (m.get(k) || []).concat(r)); } return m; };

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
    const t = String(tag).toLowerCase(), pick = (term, verb) => (rules || []).filter(r => r.verb === verb && r.term.toLowerCase() === term).flatMap(r => r.args.map(a => ({ name: a, note: r.note })));
    const required = pick(t, 'обязательно'), optional = pick(t, 'можно'), global = pick('*', 'можно');
    const values = attr => { const a = String(attr).toLowerCase(); const r = (rules || []).find(x => x.verb === 'значения' && (x.term.toLowerCase() === t + '[' + a + ']')) || (rules || []).find(x => x.verb === 'значения' && x.term.toLowerCase() === '*[' + a + ']'); return r ? { list: r.args, note: r.note } : null; };
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
    const b = blank(code, 'css'), out = [], REQ = byTerm(rules, 'требует');
    if(!REQ.size) return out;
    const blocks = [];
    for(const m of b.matchAll(/([^{}]*)\{([^{}]*)\}/g)){
      const sel = m[1].trim().replace(/\s+/g, ' '), body = m[2], at = m.index + m[1].length + 1;
      const decls = [...body.matchAll(/([\w-]+)\s*:\s*([^;]*)/g)].map(d => ({ prop: d[1].toLowerCase(), val: d[2].trim().toLowerCase(), from: at + d.index }));
      blocks.push({ sel, decls });
    }
    for(const bl of blocks) for(const d of bl.decls) for(const r of REQ.get(d.prop) || []){
      const need = r.args[0].match(/^([\w-]+)\s*(?::\s*(.+))?$/); if(!need) continue;
      const np = need[1].toLowerCase(), vals = need[2] ? need[2].split(/\s*\|\s*|\s+или\s+/).map(v => v.trim().toLowerCase()) : null;
      const has = blocks.filter(x => x.sel === bl.sel).some(x => x.decls.some(y => y.prop === np && (!vals || vals.some(v => y.val.split(/\s+/).includes(v)))));
      if(!has) out.push({ from: d.from, to: d.from + d.prop.length, msg: d.prop + ' не сработает без ' + np + (vals ? ': ' + vals.join(' или ') : '') + ' у «' + bl.sel + '»' + (r.note ? ' — ' + r.note : ''), level: 'warn' });
    }
    return out;
  }

  // JS/Python и прочий код: «внутри» — среди заголовков блоков вокруг есть нужное слово; «после» — предыдущий
  // блок того же уровня начинался с нужного слова. Блоки — по { } или по отступам (Python)
  function checkCode(code, lang, rules){
    const IN = byTerm(rules, 'внутри'), NOTIN = byTerm(rules, 'не внутри'), AFTER = byTerm(rules, 'после');
    if(!IN.size && !AFTER.size && !NOTIN.size) return [];
    const b = blank(code, lang), lines = b.split('\n'), out = [];
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

  const api = { VERBS, parse, check, templateFor, describe, blank, attrsFor };
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StructureRules = api;
})(typeof self !== 'undefined' ? self : this);
