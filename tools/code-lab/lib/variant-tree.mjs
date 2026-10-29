// Дерево вариантов: слово-смысл («отступ») → термины («margin» внешний, «padding» внутренний) →
// их разновидности по имени (margin → margin-inline → margin-inline-start) → конструкции и куски-примеры.
// Ничего не прописывается руками: всё выводится из синонимов, словаря и библиотеки.
//   buildVariants({ q, lang, dict, rows, codeOf }) → { q, lang, roots:[node] }
//   node = { term, lang, code, note, label, children:[node], piece? }

const MAX_ROOTS = 8, MAX_KIDS = 14;
const HTML_TAGS = new Set('a abbr address article aside audio b blockquote body br button canvas caption code col datalist dd details dialog div dl dt em fieldset figure footer form h1 h2 h3 h4 h5 h6 head header hr html i iframe img input label legend li link main menu meta nav ol optgroup option output p picture pre progress script section select slot small source span strong style sub summary sup svg table tbody td template textarea tfoot th thead time title tr ul video'.split(' '));
const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();
const stem = w => w.length > 5 ? w.slice(0, w.length - 2) : w;   // отступы/отступ/отступов → «отсту…»
const words = s => norm(s).split(/[^\p{L}\p{N}_-]+/u).filter(w => w.length > 1);
const isIdiom = k => /[\s(=.:]/.test(k.replace(/^[.#@]/, ''));
// обрывки старого импорта («body { margin» — строку разрезало по двоеточию): скобки не сходятся
const balanced = k => { let d = 0; for(const ch of k){ if('({['.includes(ch)) d++; else if(')}]'.includes(ch)) d--; if(d < 0) return false; } return d === 0; };

// словарь хранит ключи строчными, а в коде регистр важен: берём самое частое написание имени из библиотеки
export function caseMapFrom(codes){
  const cnt = new Map();
  for(const c of codes) for(const m of String(c || '').matchAll(/[A-Za-z_$][\w$]*/g)){ const w = m[0], lw = w.toLowerCase(); if(w === lw) continue;
    let e = cnt.get(lw); if(!e){ e = new Map(); cnt.set(lw, e); } e.set(w, (e.get(w) || 0) + 1); }
  const lowerSeen = new Map(); for(const c of codes) for(const m of String(c || '').matchAll(/[a-z_$][\w$]*/g)) if(m[0] === m[0].toLowerCase()) lowerSeen.set(m[0], (lowerSeen.get(m[0]) || 0) + 1);
  const map = new Map();
  for(const [lw, e] of cnt){ let best = null, n = 0; for(const [w, k] of e) if(k > n){ best = w; n = k; } if(n > (lowerSeen.get(lw) || 0)) map.set(lw, best); }
  return map;
}
export const recase = (text, map) => !map ? text : String(text).replace(/[A-Za-z_$][\w$]*/g, w => map.get(w) || w);

// значение словаря вида «1.5em: задать значение…» → пример значения и пояснение
function splitNote(v){
  const s = String(v || '');
  const m = s.match(/^([^:а-яё]{1,60}?):\s+(.+)$/i);
  if(m && !/[а-яё]/i.test(m[1])) return { ex: m[1].trim(), note: m[2].trim() };
  return { ex: '', note: s.replace(/^[^—]{1,40}—\s*/, '').trim() };
}
function codeFor(term, lang, ex, cm){
  if(lang === 'css') return term + ': ' + (ex || '…') + ';';
  // в HTML-словаре и теги, и атрибуты: тег — в угловых скобках, атрибут — как пишется внутри тега
  if(lang === 'html') return /^</.test(term) ? term : HTML_TAGS.has(term) ? '<' + term + '>' : (/=/.test(term) ? term : term + (ex && !/[а-яё]/i.test(ex) ? '="' + ex.replace(/^["']|["']$/g, '') + '"' : ''));
  return recase(term, cm);
}

export function buildVariants({ q, lang = '', dict, rows = [], synonyms = {}, caseMap = null }){
  const qn = norm(q); if(!qn) return { q, lang, roots: [] };
  const qw = words(qn).map(stem);
  const langs = dict && dict.langs ? dict.langs : {};
  const want = lang && langs[lang] ? [lang] : Object.keys(langs);
  const hasQ = text => { const tw = words(text); return qw.every(w => tw.some(t => t.startsWith(w))); };

  // корни: термины, у которых синоним совпал со смыслом запроса, сам термин равен запросу или начинается с него
  const roots = [];
  const seen = new Set();
  const add = (term, L, label, score) => { const k = L + '\u0000' + term; if(seen.has(k)) return; seen.add(k); roots.push({ term, lang: L, label, score }); };
  const W = (dict && dict.words) || {};
  const tokRe = t => new RegExp('(^|[^\\w-])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])');
  // синонимы и словарь записаны по-разному (.settimeout / settimeout, for / «for (const item of items)»):
  // точное совпадение → общее слово (js) → термин, у которого есть только конструкции с ним
  const resolve = (term, D, L) => {
    const t = String(term).toLowerCase().trim().replace(/^\.(?=[a-z])/, '');
    if(D[t]) return { key: t, rank: 1 };
    if((L === 'js' || L === 'ts') && W[t]) return { key: t, rank: 1.5 };   // for, while — базовые слова языка
    if(t.length < 2 || /\s/.test(t)) return null;
    const re = tokRe(t); for(const k of Object.keys(D)) if(isIdiom(k) && balanced(k) && re.test(k)) return { key: t, rank: 0.5 };
    return null;
  };
  for(const L of want){
    const D = langs[L] || {};
    for(const [term, phrases] of Object.entries(synonyms || {})){
      if(!Array.isArray(phrases)) continue;
      const hit = phrases.find(p => hasQ(p)); if(!hit) continue;
      const res = resolve(term, D, L); if(!res) continue;
      add(res.key, L, hit, 3 - Math.min(2, words(hit).length - qw.length) + res.rank);
    }
    if(D[qn]) add(qn, L, '', 4);
    if(/^[a-z]/.test(qn)) for(const k of Object.keys(D)) if(k.startsWith(qn) && !k.includes(' ') && k !== qn && !roots.some(r => k.startsWith(r.term + '-'))) add(k, L, '', 1);
  }
  // корень, который сам — разновидность другого корня (margin-top при margin), уходит внутрь
  const top = roots.filter(r => !roots.some(o => o !== r && o.lang === r.lang && r.term.startsWith(o.term + '-')))
    .sort((a, b) => b.score - a.score || a.term.length - b.term.length).slice(0, MAX_ROOTS);

  const synLabel = term => { const p = synonyms[term]; return Array.isArray(p) && p.length ? p[0] : ''; };
  const node = (term, L, label) => {
    const D = langs[L] || {}; const own = D[term] || ((L === 'js' || L === 'ts') ? W[term] : '');
    const { ex, note } = splitNote(own);
    // у термина нет своей записи — показываем самую короткую конструкцию с ним («array.sort((a, b) => a - b)»)
    let code = codeFor(term, L, ex, caseMap);
    if(!own && L !== 'css' && L !== 'html'){ const re = tokRe(term); const k = Object.keys(D).filter(x => isIdiom(x) && balanced(x) && re.test(x)).sort((a, b) => a.length - b.length)[0]; if(k) code = recase(k, caseMap); }
    return { term, lang: L, code, note: note || (own ? '' : ''), label: label || synLabel(term), children: [] };
  };
  const out = top.map(r => {
    const D = langs[r.lang] || {}; const root = node(r.term, r.lang, r.label);
    // разновидности по имени: каждая — под самым длинным уже существующим предком
    const kin = Object.keys(D).filter(k => k.startsWith(r.term + '-') && !isIdiom(k)).sort((a, b) => a.length - b.length);
    const byTerm = new Map([[r.term, root]]);
    for(const k of kin.slice(0, 60)){
      let parent = root; for(let p = k.lastIndexOf('-'); p > 0; p = k.lastIndexOf('-', p - 1)){ const pre = k.slice(0, p); if(byTerm.has(pre)){ parent = byTerm.get(pre); break; } }
      if(parent.children.length >= MAX_KIDS) continue;
      const n = node(k, r.lang); parent.children.push(n); byTerm.set(k, n);
    }
    // конструкции словаря, где термин стоит как отдельное слово («margin: 0 auto», «.queryselector(»)
    const re = new RegExp('(^|[^\\w-])' + r.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])');
    const idioms = Object.keys(D).filter(k => k !== r.term && isIdiom(k) && balanced(k) && re.test(k)).sort((a, b) => a.length - b.length).slice(0, 6);
    idioms.forEach(k => root.children.push({ term: k, lang: r.lang, code: r.lang === 'css' ? k : recase(k, caseMap), note: splitNote(D[k]).note, label: '', children: [] }));
    // в коде (не CSS) верхняя строка вставляет готовый вызов «document.querySelector(selector)», а не голое имя
    if(r.lang !== 'css' && r.lang !== 'html'){ const call = idioms.find(k => k.startsWith(r.term + '(')); if(call){ root.code = recase(call, caseMap); root.children = root.children.filter(c => c.term !== call); } }
    // куски-примеры: короткие, где термин встречается в коде или названии
    const pieces = rows.filter(x => x.lang === r.lang && re.test(String(x.title || '').toLowerCase() + ' ' + String(x.code || '').toLowerCase()))
      .sort((a, b) => (a.nlines || 99) - (b.nlines || 99)).slice(0, 3);
    pieces.forEach(x => root.children.push({ term: x.title, lang: x.lang, code: '', note: x.title, label: '', children: [], piece: x.id }));
    return root;
  });
  return { q, lang, roots: out };
}
