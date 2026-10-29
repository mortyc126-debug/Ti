// Подписи к именам «даёт/нужно»: что это такое простыми словами. Собирается из того, как имя объявлено
// в коде (функция, модуль, элемент страницы, результат вызова…), и из словаря пояснений — без ручного труда.
//   explainNames(code, lang, names, dict) → { имя: { kind, text, service } }
// service — служебное (i, a, tmp, результат): показывается приглушённо, чтобы было видно главное.

const SERVICE = new Set('i j k n x y z a b c d e t s v w el tmp temp res result results ret out acc cur prev val value item items key idx index len count sum total data obj arr list str num err e2 ok результат итог сумма значение элемент число строка список'.split(' '));
// общие имена-«подстановки»: у них в словаре чужой смысл (key — «ключ сортировки», type — поле package.json)
const GENERIC = new Set('value values key keys type header headers name names id data options opts config event target text item items index args params body response request error message node parent child root list map set state props'.split(' '));
const clean = s => String(s || '').split(':')[0].trim();
const short = (s, n = 90) => { s = String(s || '').replace(/^[^—]{1,40}—\s*/, '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// словарь: сначала язык куска, потом общие; плюс индекс идиом по «опорному» вызову (getcontext → «получить контекст…»)
function dictLookup(dict, lang){
  const L = (dict && dict.langs && dict.langs[lang]) || {}, W = (dict && dict.words) || {};
  // пояснение, а не список синонимов («ошибка, общая ошибка, исключение…» подписью не годится)
  const isList = t => (String(t).match(/,/g) || []).length >= 3 && !/[—:]/.test(t) && String(t).split(',').every(p => p.trim().split(/\s+/).length <= 3);
  const word = k => { k = String(k || '').toLowerCase(); const v = L[k] || W[k] || ''; return v && !isList(v) ? v : ''; };
  let idioms = null;
  const idiom = member => {
    if(!idioms){ idioms = new Map();
      for(const src of [L, W]) for(const [k, v] of Object.entries(src)){ if(!/[(.=\s]/.test(k)) continue;
        if(isList(v)) continue;
        // только вызовы методов через точку: «.getcontext(» — по имени метода, без точки — слишком общо
        for(const m of k.matchAll(/\.([a-z_$][\w$]{4,})\s*\(/g)){ const a = idioms.get(m[1]); if(!a || k.length < a.k.length) idioms.set(m[1], { k, v }); } } }
    const hit = idioms.get(String(member || '').toLowerCase()); return hit ? hit.v : '';
  };
  return { word, idiom };
}

function literalKind(expr){
  const x = expr.trim();
  if(/^\[/.test(x)) return 'список';
  if(/^\{/.test(x)) return 'объект';
  if(/^-?\d/.test(x)) return 'число';
  if(/^['"`]/.test(x)) return 'строка';
  if(/^(true|false|True|False)\b/.test(x)) return 'да/нет';
  if(/^(null|undefined|None)\b/.test(x)) return 'пока пусто';
  return '';
}

// что внутри значения: «список: ['чай', 'кофе'] (2)», «объект: { name, age }», «число: 42»
function literalPreview(expr, kind){
  const x = expr.trim().replace(/\s+/g, ' ');
  const cut = (t, n) => t.length > n ? t.slice(0, n - 1) + '…' : t;
  if(kind === 'список'){
    // элементы верхнего уровня: запятые вне вложенных скобок и строк
    let d = 0, q = '', n = 0, end = -1;
    for(let i = 1; i < x.length; i++){ const c = x[i];
      if(q){ if(c === '\\'){ i++; continue; } if(c === q) q = ''; continue; }
      if('\'"`'.includes(c)){ q = c; continue; }
      if('([{'.includes(c)) d++; else if(')]}'.includes(c)){ if(d === 0){ end = i; break; } d--; } else if(c === ',' && d === 0) n++; }
    const body = end > 0 ? x.slice(0, end + 1) : x; const count = end > 0 ? (body.slice(1, -1).trim() ? n + 1 : 0) : null;
    return 'список: ' + cut(body, 48) + (count != null ? ' (' + count + ')' : '');
  }
  if(kind === 'объект'){ const keys = [...x.matchAll(/[{,]\s*["']?([\wА-Яа-яЁё$]+)["']?\s*:/g)].map(m => m[1]); return 'объект' + (keys.length ? ': { ' + cut(keys.slice(0, 6).join(', '), 48) + (keys.length > 6 ? ', …' : '') + ' }' : ''); }
  return kind + ': ' + cut(x.replace(/;$/, ''), 40);
}

// что за выражение справа от «=»: модуль, элемент, новый объект, результат вызова
function explainExpr(expr, D){
  const x = expr.trim();
  let m;
  if((m = x.match(/^(?:await\s+)?require\(\s*['"`]([^'"`]+)['"`]/))) return { kind: 'модуль', text: 'модуль ' + m[1] + (D.word(m[1]) ? ': ' + short(D.word(m[1]), 60) : '') };
  if((m = x.match(/(?:querySelector(?:All)?|getElementById|getElementsByClassName)\(\s*['"`]([^'"`]+)['"`]/))) return { kind: 'элемент', text: (/All|ClassName/.test(x) ? 'элементы страницы ' : 'элемент страницы ') + m[1] };
  if((m = x.match(/^new\s+([A-Za-z_$][\w$.]*)/))) { const n = D.word(m[1].split('.').pop()); return { kind: 'объект', text: 'новый ' + m[1] + (n ? ': ' + short(n, 60) : '') }; }
  if((m = x.match(/^(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/)) || (m = x.match(/^(?:async\s+)?function\b\s*[\w$]*\s*\(([^)]*)\)/))) return { kind: 'функция', text: 'функция (' + (m[1] != null ? m[1] : m[2] || '').replace(/\s+/g, ' ').trim() + ')' };
  const lit = literalKind(x); if(lit) return { kind: 'значение', text: literalPreview(x, lit) };
  // взять из списка: набор[i] — «элемент из набор», с random — «случайный элемент из набор» (иначе подпись уйдёт в random())
  if((m = x.match(/^([A-Za-zА-Яа-яЁё_$][\wА-Яа-яЁё$.]*)\[([\s\S]+)\]$/))) return { kind: 'значение', text: (/random/i.test(m[2]) ? 'случайный элемент из ' : 'элемент из ') + m[1] + (/^\d+$/.test(m[2].trim()) ? ' (№' + m[2].trim() + ')' : '') };
  // последний вызов в выражении: obj.method(…) или func(…)
  // метод через точку — по идиомам словаря (obj.getContext(…)); просто функция — по слову словаря (fetch(…))
  const calls = [...x.matchAll(/(\.)?([A-Za-z_$][\w$]*)\s*\(/g)].map(c => ({ name: c[2], member: !!c[1] })).filter(c => !/^(await|function|return)$/.test(c.name));
  for(const c of calls.slice().reverse()){ const n = c.member ? (D.idiom(c.name) || (c.name.length > 5 ? D.word(c.name) : '')) : D.word(c.name); if(n) return { kind: 'результат', text: 'результат ' + c.name + '(): ' + short(n, 70) }; }
  if(calls.length) return { kind: 'результат', text: 'результат ' + calls[calls.length - 1].name + '()' };
  return null;
}

function declOf(code, name, lang){
  const N = esc(name); let m;
  if(lang === 'python'){
    if((m = code.match(new RegExp('^\\s*(?:async\\s+)?def\\s+' + N + '\\s*\\(([^)]*)\\)', 'm')))) return { kind: 'функция', text: 'функция (' + m[1].replace(/\s+/g, ' ').trim() + ')' };
    if(new RegExp('^\\s*class\\s+' + N + '\\b', 'm').test(code)) return { kind: 'класс', text: 'класс — шаблон для объектов' };
    if((m = code.match(new RegExp('^\\s*import\\s+([\\w.]+)\\s+as\\s+' + N + '\\b', 'm'))) || (m = code.match(new RegExp('^\\s*import\\s+(' + N + ')\\b', 'm')))) return { kind: 'модуль', text: 'модуль ' + m[1] };
    if((m = code.match(new RegExp('^\\s*from\\s+([\\w.]+)\\s+import\\s+[^\\n]*\\b' + N + '\\b', 'm')))) return { kind: 'модуль', text: 'из модуля ' + m[1] };
    if((m = code.match(new RegExp('^\\s*' + N + '\\s*=(?!=)\\s*([^\\n]+)', 'm')))) return { expr: m[1] };
    return null;
  }
  if((m = code.match(new RegExp('(?:^|[^\\w$.])function\\s*\\*?\\s*' + N + '\\s*\\(([^)]*)\\)')))) return { kind: 'функция', text: 'функция (' + m[1].replace(/\s+/g, ' ').trim() + ')' };
  if(new RegExp('(?:^|[^\\w$.])class\\s+' + N + '\\b').test(code)) return { kind: 'класс', text: 'класс — шаблон для объектов' };
  if((m = code.match(new RegExp('import\\s+(?:\\*\\s+as\\s+)?' + N + '\\s+from\\s+[\'"`]([^\'"`]+)'))) || (m = code.match(new RegExp('import\\s*\\{[^}]*\\b' + N + '\\b[^}]*\\}\\s*from\\s*[\'"`]([^\'"`]+)')))) return { kind: 'модуль', text: 'из модуля ' + m[1] };
  if((m = code.match(new RegExp('(?:const|let|var)\\s*\\{[^}]*\\b' + N + '\\b[^}]*\\}\\s*=\\s*([^;\\n]+)')))) { const r = explainExprLite(m[1]); return { kind: 'часть', text: 'взято из ' + r }; }
  if((m = code.match(new RegExp('(?:const|let|var)\\s+' + N + '\\s*=\\s*([^;\\n]+(?:\\n\\s+[^;\\n]+)?)')))) return { expr: m[1] };
  return null;
}
const explainExprLite = e => { const x = e.trim(); const r = x.match(/require\(\s*['"`]([^'"`]+)/); return r ? 'модуля ' + r[1] : x.slice(0, 40); };

export function explainNames(code, lang, names, dict){
  lang = String(lang || 'js').toLowerCase(); code = String(code || '');
  const D = dictLookup(dict, lang === 'ts' ? 'js' : lang);
  const out = {};
  for(const raw of names || []){
    const name = clean(raw); if(!name || out[name]) continue;
    let r = null;
    if(name[0] === '#') r = { kind: 'элемент', text: 'элемент страницы с id="' + name.slice(1) + '"' };
    else if(name[0] === '.') r = { kind: 'элемент', text: 'элементы с классом «' + name.slice(1) + '»' };
    else if(name.startsWith('tbl:')) r = { kind: 'таблица', text: 'таблица базы «' + name.slice(4) + '»' };
    else if(name.startsWith('--')) r = { kind: 'стиль', text: 'CSS-переменная' };
    else if(name.startsWith('@')) r = { kind: 'стиль', text: 'CSS-правило ' + name };
    else {
      const d = declOf(code, name, lang);
      if(d && d.expr != null) r = explainExpr(d.expr, D) || null;
      else if(d) r = d;
      // у коротких и общих имён словарь путает (a — тег ссылки, key — ключ сортировки)
      const own = name.length > 2 && !GENERIC.has(name.toLowerCase()) && !SERVICE.has(name.toLowerCase()) ? D.word(name) : '';
      if(own && (!r || r.kind === 'значение' || r.kind === 'результат' && !/: /.test(r.text))) r = { kind: (r && r.kind) || 'имя', text: short(own) };
      if(!r && !d) r = { kind: 'снаружи', text: 'берётся снаружи: объяви выше или возьми из другого куска' };
      if(!r) r = { kind: 'имя', text: '' };
    }
    r.service = !/^[#.@]|^tbl:|^--/.test(name) && (name.length <= 2 || SERVICE.has(name.toLowerCase())) && r.kind !== 'функция' && r.kind !== 'класс' && r.kind !== 'модуль';
    out[name] = r;
  }
  return out;
}
