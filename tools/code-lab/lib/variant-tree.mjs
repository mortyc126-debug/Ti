// дерево вариантов для подсказок: смысл («отступ») → термины (margin — внешний, padding — внутренний)
// → их разновидности по имени (margin → margin-inline → margin-inline-start) → конструкции и куски-примеры.
// ничего не прописано вручную: всё берётся из синонимов, словаря и библиотеки.
//
//   buildVariants({ q, lang, dict, rows, synonyms, caseMap }) → { q, lang, roots: [узел] }
//   узел = { term, lang, code, note, label, children: [узел], piece? }

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const StructureRules = require('../public/structure-rules.js');
import { matchQueryPhrase } from './query-phrase-match.mjs';

const MAX_ROOTS = 8, MAX_KIDS = 14;
const HTML_TAGS = new Set('a abbr address article aside audio b blockquote body br button canvas caption code col datalist dd details dialog div dl dt em fieldset figure footer form h1 h2 h3 h4 h5 h6 head header hr html i iframe img input label legend li link main menu meta nav ol optgroup option output p picture pre progress script section select slot small source span strong style sub summary sup svg table tbody td template textarea tfoot th thead time title tr ul video'.split(' '));
const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();
const stem = w => w.length > 5 ? w.slice(0, w.length - 2) : w;   // отступы/отступ/отступов → «отсту…»
const words = s => norm(s).split(/[^\p{L}\p{N}_-]+/u).filter(w => w.length > 1);
const isIdiom = k => /[\s(=.:]/.test(k.replace(/^[.#@]/, ''));
// обрывки старого импорта («body { margin» — строку разрезало по двоеточию): скобки не сходятся
const balanced = k => { let d = 0; for(const ch of k){ if('({['.includes(ch)) d++; else if(')}]'.includes(ch)) d--; if(d < 0) return false; } return d === 0; };

// словарь хранит ключи строчными, а в коде регистр важен: берём самое частое написание имени из библиотеки
// регистр восстанавливаем голосованием по коду библиотеки.
// для каждого слова считаем, как его пишут: queryselector → { querySelector: 40, QuerySelector: 1 }.
// побеждает самое частое написание, но только если оно встречается чаще, чем слово целиком строчными —
// иначе какое-нибудь «name», которое почти всегда строчное, превратилось бы в «Name» из-за одного класса.
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
  if(lang === 'css' && term[0] === '@') return term + ' (…) { }';   // @media, @supports — правило с условием, не свойство
  if(lang === 'css') return term + ': ' + (ex || '…') + ';';
  // в HTML-словаре и теги, и атрибуты: тег — в угловых скобках, атрибут — как пишется внутри тега
  if(lang === 'html') return /^</.test(term) ? term : HTML_TAGS.has(term) ? '<' + term + '>' : (/=/.test(term) ? term : term + (ex && !/[а-яё]/i.test(ex) ? '="' + ex.replace(/^["']|["']$/g, '') + '"' : ''));
  return recase(term, cm);
}

// Индексы словаря строятся один раз на объект dict и переиспользуются между запросами редактора.
// Это убирает повторный полный обход ключей при каждом набранном символе.
const DICT_INDEX_CACHE = new WeakMap();
function dictIndexes(dict){
  if(!dict || typeof dict !== 'object') return {};
  const cached = DICT_INDEX_CACHE.get(dict); if(cached) return cached;
  const result = {};
  const add = (map, key, value) => {
    if(!key) return;
    if(!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  for(const [lang, dictionary] of Object.entries(dict.langs || {})){
    const keys = Object.keys(dictionary || {});
    const idioms = keys.filter(key => isIdiom(key) && balanced(key));
    const idiomsByToken = new Map(), prefixes = new Map(), memberPrefixes = new Map(), hyphenChildren = new Map();
    for(const key of keys){
      const lower = key.toLowerCase();
      for(let i = 1; i <= Math.min(32, lower.length); i++) add(prefixes, lower.slice(0, i), key);
      for(const part of lower.split('.')) for(let i = 1; i <= Math.min(32, part.length); i++) add(memberPrefixes, part.slice(0, i), key);
      if(!isIdiom(key)){
        const parts = lower.split('-');
        for(let i = 1; i < parts.length; i++) add(hyphenChildren, parts.slice(0, i).join('-'), key);
      }
    }
    for(const key of idioms) for(const token of words(key)) add(idiomsByToken, token, key);
    result[lang] = { keys, idioms, idiomsByToken, prefixes, memberPrefixes, hyphenChildren };
  }
  DICT_INDEX_CACHE.set(dict, result);
  return result;
}

export function buildVariants({ q, lang = '', dict, rows = [], synonyms = {}, caseMap = null }){
  const qn = norm(q); if(!qn) return { q, lang, roots: [] };
    const langs = dict && dict.langs ? dict.langs : {};
  const indexes = dictIndexes(dict);
  const want = lang && langs[lang] ? [lang] : Object.keys(langs);

  // корни: термины, у которых синоним совпал со смыслом запроса, сам термин равен запросу или начинается с него
  const roots = [];
  const seen = new Set();
  const add = (term, L, label, score) => { const k = L + '\u0000' + term; if(seen.has(k)) return; seen.add(k); roots.push({ term, lang: L, label, score }); };
  const W = (dict && dict.words) || {};
  const tokRe = t => new RegExp('(^|[^\\w-])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])');
  // синонимы и словарь записаны по-разному (.settimeout / settimeout, for / «for (const item of items)»):
  // точное совпадение → общее слово (js) → термин, у которого есть только конструкции с ним
  const resolve = (term, D, L) => {
    const t = String(term).toLowerCase().trim().replace(/^\.(?=[a-z])/, '').replace(/^<([a-z][\w-]*)>$/, (L === 'html' || L === 'svg') ? '$1' : '<$1>');   // синоним «<img>» ↔ запись словаря «img»
    if(D[t]) return { key: t, rank: 1 };
    if((L === 'html' || L === 'svg') && D['<' + t + '>']) return { key: '<' + t + '>', rank: 1 };
    if((L === 'js' || L === 'ts') && W[t]) return { key: t, rank: 1.5 };   // for, while — базовые слова языка
    if(t.length < 2 || /\s/.test(t)) return null;
    const re = tokRe(t), ix = indexes[L];
    const candidates = ix ? (ix.idiomsByToken.get(t) || (/[.@#]/.test(t) ? ix.idioms : [])) : [];
    for(const k of candidates) if(re.test(k)) return { key: t, rank: 0.5 };
    return null;
  };
  for(const L of want){
    const D = langs[L] || {};
    for(const [term, phrases] of Object.entries(synonyms || {})){
      if(!Array.isArray(phrases)) continue;
      const matches = phrases.map(phrase => ({ phrase, match: matchQueryPhrase(qn, phrase, term) }))
        .filter(item => item.match).sort((a, b) => b.match.score - a.match.score);
      const hit = matches[0]; if(!hit) continue;
      const res = resolve(term, D, L); if(!res) continue;
      add(res.key, L, hit.phrase, 2 + hit.match.score / 20 + res.rank);
    }
    // латиницей пишут начало имени («quer») — совпадение по началу важнее смысла по синонимам
    const latin = /^[a-z]/.test(qn);
    if(D[qn]) add(qn, L, '', latin ? 9 : 4);
    if(latin){ const ix = indexes[L]; const candidates = ix ? [...new Set([...(ix.prefixes.get(qn) || []), ...(ix.memberPrefixes.get(qn) || [])])] : [];
      for(const k of candidates) if(!/[\s(=]/.test(k) && k !== qn && !roots.some(r => k.startsWith(r.term + '-'))) add(k, L, '', 8 - Math.min(3, k.length / 12)); }
  }
  if(/^[a-z]/.test(qn) && roots.some(r => r.score >= 5)) for(let i = roots.length - 1; i >= 0; i--) if(roots[i].score < 5) roots.splice(i, 1);
  // если корень — разновидность другого корня (margin-top при margin), прячем его внутрь
  const top = roots.filter(r => !roots.some(o => o !== r && o.lang === r.lang && r.term.startsWith(o.term + '-')))
    .sort((a, b) => b.score - a.score || a.term.length - b.term.length).slice(0, MAX_ROOTS);

  // Единый парсер структуры — тот же, который использует сервер и редактор правил.
  // Дерево не пытается повторно интерпретировать грамматику регулярными выражениями.
  const rulesCache = new Map();
  const rulesFor = L => {
    if(rulesCache.has(L)) return rulesCache.get(L);
    const lines = (dict && dict.structure && dict.structure[L]) || [];
    const parsed = StructureRules.parse(lines.join('\n'));
    rulesCache.set(L, parsed.rules);
    return parsed.rules;
  };
  const tplOf = (L, term) => StructureRules.templateFor(String(term).replace(/^<|>$/g, ''), rulesFor(L)) || '';
  const needOf = (L, term) => rulesFor(L)
    .filter(r => norm(r.term) === norm(String(term).replace(/^<|>$/g, '')) && r.verb === 'обязательно')
    .flatMap(r => r.args);

  const relationLabels = {
    'после': 'Следует после',
    'внутри': 'Расположение внутри',
    'не внутри': 'Запрещённое расположение',
    'содержит': 'Состав конструкции',
    'не содержит': 'Запрещённое содержимое',
    'первым в': 'Порядок элементов',
    'требует': 'Зависимости',
    'обязательно': 'Обязательные части',
    'можно': 'Допустимые части',
    'значения': 'Допустимые значения',
    'связывает': 'Связи с другими языками',
    'читает': 'Читаемые данные',
    'заметка': 'Пояснения'
  };
  const relationDescriptions = {
    'после': 'Порядок относительно предыдущей конструкции',
    'внутри': 'Контекст, в котором допустима конструкция',
    'не внутри': 'Контексты, в которых конструкция запрещена',
    'содержит': 'Элементы, входящие в состав конструкции',
    'не содержит': 'Элементы, которые нельзя помещать внутрь',
    'первым в': 'Требование к позиции внутри родителя',
    'требует': 'Необходимые свойства, условия или зависимости',
    'обязательно': 'Обязательные атрибуты или части',
    'можно': 'Необязательные атрибуты или части',
    'значения': 'Допустимые значения свойства или атрибута',
    'связывает': 'Связь с конструкциями другого языка',
    'читает': 'Источник или формат читаемых данных',
    'заметка': 'Справочное пояснение без проверки'
  };
  const relationGroups = (term, L) => {
    const langRules = rulesFor(L), key = norm(term), D = langs[L] || {};
    const exists = t => Object.prototype.hasOwnProperty.call(D, String(t).toLowerCase()) ||
      langRules.some(r => norm(r.term) === norm(t));
    const groups = new Map();
    const add = (verb, show, rule, target = '', targetLang = L, actionable = false) => {
      if(!groups.has(verb)) groups.set(verb, []);
      const note = [rule.note, relationDescriptions[verb]].filter(Boolean).join(' · ');
      let item;
      if(actionable && target && targetLang === L && exists(target)){
        item = node(target, targetLang, verb);
        item.note = [item.note, rule.note, relationDescriptions[verb]].filter(Boolean).join(' · ');
      } else {
        item = { term: target || '', lang: targetLang, code: '', show, label: '', note, relation: verb, children: [] };
      }
      item.relation = verb;
      groups.get(verb).push(item);
    };
    for(const r of langRules){
      const own = norm(r.term) === key;
      const refs = r.args.map(a => norm(a));
      if(r.verb === 'после' && refs.includes(key) && exists(r.term))
        add('после', r.term + ' — следует после ' + term, r, r.term, L, true);
      if(r.verb === 'внутри' && own)
        r.args.forEach(a => add('внутри', term + ' находится внутри ' + a, r, a, L, true));
      if(r.verb === 'внутри' && refs.includes(key) && exists(r.term))
        add('содержит', term + ' содержит ' + r.term, r, r.term, L, true);
      if(r.verb === 'не внутри' && own)
        r.args.forEach(a => add('не внутри', term + ' нельзя размещать внутри ' + a, r, a));
      if(r.verb === 'не внутри' && refs.includes(key) && exists(r.term))
        add('не содержит', term + ' не может содержать ' + r.term, r, r.term, L, true);
      if(r.verb === 'содержит' && own)
        r.args.forEach(a => add('содержит', term + ' содержит ' + a, r, a, L, true));
      if(r.verb === 'содержит' && refs.includes(key) && exists(r.term))
        add('содержит', r.term + ' содержит ' + term, r, r.term, L, true);
      if(r.verb === 'не содержит' && own)
        r.args.forEach(a => add('не содержит', term + ' не может содержать ' + a, r, a));
      if(r.verb === 'не содержит' && refs.includes(key) && exists(r.term))
        add('не содержит', r.term + ' не может содержать ' + term, r, r.term, L, true);
      if(r.verb === 'первым в' && own)
        r.args.forEach(a => add('первым в', term + ' должен быть первым в ' + a, r, a, L, true));
      if(r.verb === 'первым в' && refs.includes(key) && exists(r.term))
        add('первым в', r.term + ' должен быть первым в ' + term, r, r.term, L, true);
      if(own && ['требует','обязательно','можно','значения','заметка'].includes(r.verb))
        r.args.forEach(a => add(r.verb, r.verb + ': ' + a, r, a));
      if(own && ['связывает','читает'].includes(r.verb)){
        r.args.forEach(a => {
          const m = String(a).match(/^(html|css|js|ts|python|svg)\s+(.+)$/i);
          add(r.verb, a, r, m ? m[2] : a, m ? m[1].toLowerCase() : L, false);
        });
      }
    }
    return [...groups.entries()].map(([verb, children]) => ({
      group: true, label: relationLabels[verb], relation: verb,
      note: relationDescriptions[verb], lang: L, children
    }));
  };
  const synLabel = term => { const p = synonyms[term]; return Array.isArray(p) && p.length ? p[0] : ''; };
  const node = (term, L, label) => {
    const D = langs[L] || {}; const own = D[term] || ((L === 'js' || L === 'ts') ? W[term] : '');
    const { ex, note } = splitNote(own);
    // у термина нет своей записи — показываем самую короткую конструкцию с ним («array.sort((a, b) => a - b)»)
    let code = codeFor(term, L, ex, caseMap);
    if(!own && L !== 'css' && L !== 'html'){ const re = tokRe(term); const k = Object.keys(D).filter(x => isIdiom(x) && balanced(x) && re.test(x)).sort((a, b) => a.length - b.length)[0]; if(k) code = recase(k, caseMap); }
    const tpl = tplOf(L, term); if(tpl) code = tpl;
    const need = needOf(L, term);
    return { term, lang: L, code, note: (note || '') + (need.length ? (note ? '; ' : '') + 'обязательно: ' + need.join(', ') : ''), label: label || synLabel(term), children: [] };
  };
  const out = top.map(r => {
    const D = langs[r.lang] || {}; const root = node(r.term, r.lang, r.label); root.score = r.score;
    root.children.push(...relationGroups(r.term, r.lang));
    // разновидности по имени: каждая — под самым длинным уже существующим предком
    // разновидности по имени: margin → margin-inline → margin-inline-start.
    // сортируем по длине, чтобы родитель всегда шёл раньше детей. для каждого слова отрезаем хвост по дефису
    // (margin-inline-start → margin-inline → margin) и вешаем под первого найденного предка.
    // так margin-inline-start окажется внутри margin-inline, а не рядом с ним под margin.
    const kin = ((indexes[r.lang] && indexes[r.lang].hyphenChildren.get(r.term)) || []).slice().sort((a, b) => a.length - b.length);
    const byTerm = new Map([[r.term, root]]);
    for(const k of kin.slice(0, 60)){
      let parent = root; for(let p = k.lastIndexOf('-'); p > 0; p = k.lastIndexOf('-', p - 1)){ const pre = k.slice(0, p); if(byTerm.has(pre)){ parent = byTerm.get(pre); break; } }
      if(parent.children.length >= MAX_KIDS) continue;
      const n = node(k, r.lang); parent.children.push(n); byTerm.set(k, n);
    }
    // конструкции словаря, где термин стоит как отдельное слово («margin: 0 auto», «.queryselector(»)
    const re = new RegExp('(^|[^\\w-])' + r.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])');
    const idiomCandidates = /[\s.@#]/.test(r.term) ? ((indexes[r.lang] && indexes[r.lang].idioms) || []) : ((indexes[r.lang] && indexes[r.lang].idiomsByToken.get(r.term)) || []);
    const idioms = idiomCandidates.filter(k => k !== r.term && re.test(k)).sort((a, b) => a.length - b.length).slice(0, 6);
    idioms.forEach(k => root.children.push({ term: k, lang: r.lang, code: r.lang === 'css' ? k : recase(k, caseMap), note: splitNote(D[k]).note, label: '', children: [] }));
    // в коде (не CSS) верхняя строка вставляет готовый вызов «document.querySelector(selector)», а не голое имя
    if(r.lang !== 'css' && r.lang !== 'html'){ const call = idioms.find(k => k.startsWith(r.term + '(')); if(call){ root.code = recase(call, caseMap); root.children = root.children.filter(c => c.term !== call); } }
    // куски-примеры: короткие, где термин встречается в коде или названии
    const pieces = rows.filter(x => x.lang === r.lang && re.test(String(x.title || '').toLowerCase() + ' ' + String(x.code || '').toLowerCase()))
      .sort((a, b) => (a.nlines || 99) - (b.nlines || 99)).slice(0, 3);
    pieces.forEach(x => root.children.push({ term: x.title, lang: x.lang, code: '', note: x.title, label: '', children: [], piece: x.id }));
    return root;
  });
  // куски библиотеки, у которых смысл запроса в названии («адаптивный» → «Адаптивная сетка карточек»):
  // отдельной веткой, язык файла первым; для HTML подходят и CSS/JS-куски — страница собирается из всех трёх
  if(/[а-я]/.test(qn)){
    const near = lang === 'html' ? ['html', 'css', 'js'] : lang ? [lang] : [];
    const rank = x => { const i = near.indexOf(x.lang); return i < 0 ? 9 : i; };
    const hits = rows.filter(x => matchQueryPhrase(qn, x.title)).sort((a, b) => rank(a) - rank(b) || String(a.title).length - String(b.title).length);
    const pick = hits.slice(0, MAX_KIDS);
    if(pick.length) out.push({ term: '', lang: pick[0].lang, code: '', label: 'куски из библиотеки', note: hits.length + ' по названию', group: true,
      children: pick.map(x => ({ term: x.title, lang: x.lang, code: '', note: x.title + (near.length && x.lang !== near[0] ? ' · ' + x.lang.toUpperCase() : ''), label: '', children: [], piece: x.id })) });
  }
  return { q, lang, roots: out };
}
