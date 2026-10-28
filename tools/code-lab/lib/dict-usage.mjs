// Связь «слово/конструкция словаря ↔ куски библиотеки». Ничего не хранит на диске:
// индекс вычисляется из кода и словаря (код — источник правды), поэтому всегда свежий.
//
//   const usage = buildUsage(dict, entries);        // dict = kwDict(), entries = store.entries()
//   usage.sections                                  // [{id,label,total,covered,uncovered,prose,weak}]
//   usage.terms[sid][term] → { n, ids:[…], kind, note }   (n = в скольких кусках встречается)
//   usage.piecesOf(sid, term)    → [id, …]          (все куски, где встречается)
//   usage.termsOfPiece(id)       → [{sid, term, kind, n, others:[id…]}]
//   usage.gaps(sid)              → термины без единого куска
//
// Ключи словаря — не только слова, но и идиомы с подстановками: «element.addeventlistener("click", handler)».
// Точной строки в коде не будет, поэтому у каждого ключа выделяются ОПОРНЫЕ токены (имена после точки,
// ключевые слова, операторы, вызовы известных функций); «подстановочные» имена (element, array, value…)
// отбрасываются. Ключ считается найденным, если опорные токены идут в куске по порядку и недалеко друг от друга.

const KEYWORDS = new Set(('import export from as default const let var function return if else for while do switch case break continue '
  + 'try catch finally throw new typeof instanceof in of delete void yield await async class extends super static def lambda with pass '
  + 'raise except elif and or not is del global nonlocal assert struct enum typedef namespace using public private protected interface '
  + 'implements package func defer chan fn mut impl trait unsafe').split(/\s+/));

// слова, которые в ключах обычно играют роль «любое имя»: даже если часто встречаются, опорой не служат
const PLACEHOLDER_HINT = new Set(('fn func callback cb handler listener predicate comparefn mapfn reducer transform combine expression '
  + 'condition value values item items element elements array arr list obj object data result results key keys name names text str string '
  + 'input output args params param options opts config node target source dest path url error err event e x y z n i j k a b c f g h '
  + 'initial initialstate accumulator acc curr cur prev previous index idx count size length start end min max width height id token message msg '
  + 'template pattern prefix suffix separator delimiter selector label ms delay timeout milliseconds seconds default fallback defaultvalue parent child '
  + 'base query body headers flag flags bits chunk chunks buffer stream file files blob form image canvas ctx db tx socket server app request response req res').split(/\s+/));

// корни путей, которые в ключах — настоящие глобальные объекты, хотя слово бывает и «подстановкой» (object.keys, array.from)
// (слово слева от точки в ключе — обычно имя переменной-подстановки; настоящий корень — только из этих списков)
const REAL_ROOTS = new Set(('console math json promise intl reflect symbol window document navigator location history localstorage sessionstorage '
  + 'performance crypto process temporal atomics webassembly globalthis indexeddb cache caches screen').split(/\s+/));
const STATIC_MEMBERS = {
  object: new Set('keys values entries assign freeze isfrozen seal issealed fromentries create defineproperty defineproperties getprototypeof setprototypeof getownpropertynames getownpropertydescriptor getownpropertydescriptors getownpropertysymbols is hasown groupby preventextensions isextensible'.split(' ')),
  array: new Set('from isarray of fromasync'.split(' ')),
  number: new Set('isinteger isfinite isnan issafeinteger parsefloat parseint epsilon'.split(' ')),
  date: new Set('now parse utc'.split(' ')),
  string: new Set('raw fromcharcode fromcodepoint'.split(' ')),
};

const MARKUP = new Set(['html', 'css', 'scss', 'less', 'svg', 'xml', 'md', 'markdown']);
const HASH_COMMENT = new Set(['python', 'py', 'bash', 'sh', 'shell', 'zsh', 'ruby', 'rb', 'perl', 'r', 'yaml', 'yml', 'powershell', 'ps1', 'toml', 'makefile', 'dockerfile']);
const DASH_COMMENT = new Set(['sql', 'lua', 'haskell']);

const RE_IDENT = /[\p{L}_$][\p{L}\p{N}_$]*/uy;
const RE_NUM = /\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?[a-z]*/iy;
const RE_OP = /\.\.\.|\?\.|::|->|[!=<>&|?+\-*/%^~]+/y;
const RE_WORD_MARKUP = /[\p{L}\p{N}_#%@-]+/uy;

const isMember = t => t === '.' || t === '?.' || t === '::' || t === '->';

// ── лексер: текст → [{t, k}]  k: i(идентификатор) o(оператор) s(строка) n(число) p(пунктуация) ──
export function lex(code, lang, { tolerant = false } = {}) {
  const L = String(lang || '').toLowerCase();
  const out = [];
  const s = String(code || '');
  const n = s.length;
  const blanks = [];                 // диапазоны комментариев — для «чистого» текста
  const markup = MARKUP.has(L);
  const hash = HASH_COMMENT.has(L), dash = DASH_COMMENT.has(L);
  const cPre = !hash && !markup;     // «#include» в C-подобных — это слово, а не комментарий
  let i = 0;
  while (i < n) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    // комментарии
    if (markup && s.startsWith('<!--', i)) { const e = s.indexOf('-->', i + 4); const j = e < 0 ? n : e + 3; blanks.push([i, j]); i = j; continue; }
    if (s.startsWith('/*', i) && L !== 'python' && L !== 'bash') { const e = s.indexOf('*/', i + 2); const j = e < 0 ? n : e + 2; blanks.push([i, j]); i = j; continue; }
    if (!markup && s.startsWith('//', i) && !hash) { const e = s.indexOf('\n', i); const j = e < 0 ? n : e; blanks.push([i, j]); i = j; continue; }
    if (hash && ch === '#') { const e = s.indexOf('\n', i); const j = e < 0 ? n : e; blanks.push([i, j]); i = j; continue; }
    if (dash && s.startsWith('--', i)) { const e = s.indexOf('\n', i); const j = e < 0 ? n : e; blanks.push([i, j]); i = j; continue; }
    if (markup) {
      RE_WORD_MARKUP.lastIndex = i;
      const m = RE_WORD_MARKUP.exec(s);
      if (m && m.index === i) { out.push({ t: m[0].toLowerCase(), k: 'i' }); i += m[0].length; continue; }
      i++; continue;
    }
    // строки
    if (ch === '"' || ch === "'" || ch === '`') {
      const q3 = s.substr(i, 3);
      const triple = hash && (q3 === '"""' || q3 === "'''");
      const q = triple ? q3 : ch;
      let j = i + q.length, closed = false;
      while (j < n) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s.startsWith(q, j)) { closed = true; j += q.length; break; }
        if (!triple && ch !== '`' && s[j] === '\n') break;
        j++;
      }
      if (closed) { out.push({ t: 'S:' + s.slice(i + q.length, j - q.length).trim().toLowerCase().slice(0, 80), k: 's' }); if (j - q.length > i + q.length) blanks.push([i + q.length, j - q.length]); }
      else if (!tolerant) out.push({ t: 'S:', k: 's' });
      i = closed ? j : (tolerant ? n : Math.min(n, j));
      continue;
    }
    // «#include», «#define»
    if (cPre && ch === '#') {
      RE_IDENT.lastIndex = i + 1; const m = RE_IDENT.exec(s);
      if (m && m.index === i + 1) { out.push({ t: '#' + m[0].toLowerCase(), k: 'i' }); i += 1 + m[0].length; continue; }
    }
    RE_NUM.lastIndex = i; let m = RE_NUM.exec(s);
    if (m && m.index === i) { out.push({ t: 'N', k: 'n' }); i += m[0].length; continue; }
    RE_IDENT.lastIndex = i; m = RE_IDENT.exec(s);
    if (m && m.index === i) { out.push({ t: m[0].toLowerCase(), k: 'i' }); i += m[0].length; continue; }
    RE_OP.lastIndex = i; m = RE_OP.exec(s);
    if (m && m.index === i) { out.push({ t: m[0], k: isMember(m[0]) ? 'p' : 'o' }); i += m[0].length; continue; }
    out.push({ t: ch, k: 'p' }); i++;
  }
  if (blanks.length) { const a = s.split(''); for (const [x, y] of blanks) for (let q = x; q < y; q++) if (a[q] !== '\n') a[q] = ' '; out.clean = a.join(''); }
  else out.clean = s;
  return out;
}

const eligible = tk => tk.k === 'i' || tk.k === 'o' || tk.k === 's';
// одиночные операторы, которые тоже считаем опорой (остальные — шум: = < > + - * /)
const SINGLE_OPS = new Set(['!', '&', '|', '^', '~', '%']);

// ── индекс одного куска: токен → отсортированные позиции + «чистый» текст для проверки формы ──
function indexPiece(entry) {
  const tokens = lex(String(entry.code || '').slice(0, 300000), entry.lang);
  const pos = new Map();
  let p = 0;
  for (const tk of tokens) {
    if (!eligible(tk)) continue;
    if (tk.k === 'o' && tk.t.length === 1 && !SINGLE_OPS.has(tk.t)) { continue; }
    let a = pos.get(tk.t); if (!a) pos.set(tk.t, a = []);
    a.push(p++);
  }
  return { id: entry.id, lang: String(entry.lang || '').toLowerCase(), title: entry.title || entry.id, group: entry.group || '', pos, size: p, text: tokens.clean.toLowerCase() };
}

// ── разбор ключа словаря ──
function termShape(key, lang) {
  const raw = String(key);
  const tokens = lex(raw, lang, { tolerant: true });
  // русский в ИМЕНАХ (вне кавычек) — это глоссарий, а не код: «ошибка границ». Русский внутри строки — нормальный код: it("поведение", …)
  if (tokens.some(t => t.k === 'i' && /[А-Яа-яЁё]/.test(t.t))) return { kind: 'prose' };
  if (!tokens.length && /[А-Яа-яЁё]/.test(raw)) return { kind: 'prose' };
  return { kind: 'code', tokens };
}

// частоты по разделу: какие имена в ключах — «подстановки» (value, path, item…)
function sectionStats(shapes) {
  const freeCount = new Map();
  for (const sh of shapes) {
    if (sh.kind !== 'code') continue;
    const seen = new Set();
    const tk = sh.tokens;
    for (let i = 0; i < tk.length; i++) {
      if (tk[i].k !== 'i') continue;
      const w = tk[i].t;
      if (KEYWORDS.has(w)) continue;
      if (i > 0 && isMember(tk[i - 1].t)) continue;
      if (tk[i + 1] && tk[i + 1].t === '(') continue;      // вызов — настоящее имя функции
      seen.add(w);
    }
    seen.forEach(w => freeCount.set(w, (freeCount.get(w) || 0) + 1));
  }
  return { freeCount };
}

const DECL = new Set(['const', 'let', 'var', 'function', 'class', 'def', 'type', 'interface', 'enum', 'struct', 'extends', 'implements', 'fn', 'func', 'as', 'catch']);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PH = '(?:[^;]{0,60}?)';
const LIT = '(?:"[^"\\n]*"|\'[^\'\\n]*\'|`[^`]*`|\\d[\\w.]*)';
const WB = w => '(?<![\\w$])' + esc(w) + '(?![\\w$])';

// Форма ключа → регулярное выражение по «чистому» тексту куска. Настоящие имена, ключевые слова, скобки и операторы
// обязательны; подстановки (value, path, имя после const…) и литералы заменяются на «что угодно».
function shapeOf(sh, ctx) {
  const tk = sh.tokens;
  if (!tk.length) return null;
  const T = ctx.T;
  // ключ — одна строка: "use strict", "scripts"
  if (tk.length === 1 && tk[0].k === 's') return tk[0].t.length > 2 ? { mode: 'token', lits: [tk[0].t], spec: 1 } : null;
  // markup: все слова — опоры, по порядку, рядом
  if (ctx.markup) { const a = tk.filter(t => t.k === 'i').map(t => t.t); return a.length ? { mode: 'window', lits: a, spec: a.length } : null; }
  const isPath = tk.every((t, i) => (i % 2 === 0 ? t.k === 'i' : isMember(t.t))) && tk.length % 2 === 1;
  if (isPath && tk.length === 1) return { mode: 'token', lits: [tk[0].t], spec: 1 };

  // какая скобка окружает токен: нужно, чтобы отличить ключ объекта ({ style) от аргумента (fn(locale)
  const encl = []; { const st = []; for (const t of tk) { encl.push(st.length ? st[st.length - 1] : ''); if ('([{'.includes(t.t) && t.k === 'p') st.push(t.t); else if (')]}'.includes(t.t) && t.k === 'p') st.pop(); } }
  // роль каждого идентификатора: литерал или подстановка
  const lit = tk.map((t, i) => {
    if (t.k !== 'i') return false;
    const w = t.t, prev = tk[i - 1], next = tk[i + 1];
    if (KEYWORDS.has(w) || w[0] === '#') return true;
    if (prev && isMember(prev.t)) return true;                         // имя после точки — настоящее
    if (prev && prev.t === 'new') return true;                         // new Blob(…) — имя конструктора настоящее
    if (prev && prev.k === 'i' && DECL.has(prev.t) && !(next && next.t === '(') && !(next && isMember(next.t))) return false;   // const NAME / extends NAME
    if (next && isMember(next.t)) {                                    // слева от точки: имя переменной или настоящий глобальный объект
      if (REAL_ROOTS.has(w)) return true;
      const st = STATIC_MEMBERS[w], m = tk[i + 2];
      return !!(st && m && st.has(m.t));                               // Object.keys — настоящий, object.foo — подстановка
    }
    if (PLACEHOLDER_HINT.has(w)) return false;
    if (next && next.t === '(') return true;                           // вызов — настоящее имя функции
    if (isPath && i === 0) return true;                                // console.log, math.floor
    // ключ объекта: «{ style», «, signal:», «{ opendb }» — настоящее имя свойства, если оно не слишком частое
    const keyPos = encl[i] === '{' && (!next || next.t === ':' || next.t === ',' || next.t === '}');
    if (keyPos) return (ctx.freeCount.get(w) || 0) < T;
    return false;                                                      // остальные свободные имена — подстановки (аргументы, операнды)
  });
  if (!lit.some(Boolean)) tk.forEach((t, i) => { if (t.k === 'i' && !PLACEHOLDER_HINT.has(t.t)) lit[i] = true; });
  const parts = []; const lits = [];
  let spec = 0, structural = 0, lastPH = false;
  const push = (x, isPh) => { if (isPh) { if (lastPH) return; lastPH = true; } else lastPH = false; parts.push(x); };
  for (let i = 0; i < tk.length; i++) {
    const t = tk[i], next = tk[i + 1];
    if (t.k === 'i') {
      if (lit[i]) { push(WB(t.t), false); lits.push(t.t); if (!KEYWORDS.has(t.t)) spec++; }
      else if (next && next.t === '(') {                      // вызов функции-подстановки: combine(acc, item) → любое выражение
        let depth = 0, j = i + 1;
        for (; j < tk.length; j++) { if (tk[j].t === '(') depth++; else if (tk[j].t === ')' && --depth === 0) break; }
        push(PH, true); i = j;
      }
      else push(next && isMember(next.t) ? '[\\w$)\\]]+' : PH, true);
    } else if (t.k === 's' || t.k === 'n') push(LIT, true);
    else if (t.k === 'p' && isMember(t.t)) push(t.t === '.' ? '\\??\\.' : esc(t.t), false);
    else if (t.k === 'o') {
      let r = esc(t.t);
      if (t.t === '=') r = '(?<![=!<>])=(?![=>])'; else if (t.t === '!') r = '!(?!=)'; else if (t.t === '&') r = '&(?!&)'; else if (t.t === '|') r = '\\|(?!\\|)';
      push(r, false); if (t.t.length >= 2 || SINGLE_OPS.has(t.t)) lits.push(t.t);
      if (!['=', '+', '-', '*', '/', '<', '>'].includes(t.t)) structural++;
    } else { push(esc(t.t), false); if ('[]{}?:'.includes(t.t)) structural++; }
  }
  while (parts.length && parts[parts.length - 1] === PH) parts.pop();            // хвост-подстановка ничего не требует
  if (!parts.length) return null;
  let re; try { re = new RegExp(parts.join('\\s*'), 'u'); } catch (_) { return null; }
  return { mode: 'regex', re, lits, spec, structural, generic: spec === 0 && structural === 0 };
}

// ── сопоставление ──
function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }
function windowMatch(piece, anchors, window) {
  const first = piece.pos.get(anchors[0]);
  if (!first) return false;
  if (anchors.length === 1) return true;
  for (const p0 of first) {
    let cur = p0, ok = true;
    for (let j = 1; j < anchors.length; j++) {
      const arr = piece.pos.get(anchors[j]);
      if (!arr) return false;
      const k = lowerBound(arr, cur + 1);
      if (k >= arr.length || arr[k] - p0 > window) { ok = false; break; }
      cur = arr[k];
    }
    if (ok) return true;
  }
  return false;
}

const SECTION_LABEL = { common: 'Общее / код', html: 'HTML', css: 'CSS' };
const sectionLabel = sid => SECTION_LABEL[sid] || (sid.startsWith('lang:') ? 'Язык: ' + sid.slice(5) : sid);

// слить базовые секции словаря в разделы так же, как это делает окно «📚 весь словарь»
export function dictSections(dict) {
  const d = dict || {};
  const out = {};
  const put = (sid, ...objs) => { const m = {}; for (const o of objs) if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (typeof v === 'string') m[k] = v; if (Object.keys(m).length) out[sid] = m; };
  const langs = d.langs || {};
  put('html', d.htmlTags, d.htmlAttrs, langs.html);
  put('css', d.cssProps, d.cssVals, langs.css);
  for (const l of Object.keys(langs).sort()) if (l !== 'html' && l !== 'css') put('lang:' + l, langs[l]);
  put('common', d.words);
  return out;
}

// какие куски проверяем для раздела
function piecesFor(sid, pieces) {
  if (sid === 'common') return pieces;
  if (sid === 'html') return pieces.filter(p => p.lang === 'html');
  if (sid === 'css') return pieces.filter(p => p.lang === 'css' || p.lang === 'html');
  const l = sid.slice(5);
  const same = new Set([l]);
  if (l === 'js') same.add('javascript'); if (l === 'ts') same.add('typescript'); if (l === 'python') same.add('py');
  return pieces.filter(p => same.has(p.lang));
}

export function buildUsage(dict, entries) {
  const t0 = Date.now();
  const pieces = (entries || []).filter(e => e && e.id && typeof e.code === 'string' && e.code.trim()).map(indexPiece);
  const byId = new Map(pieces.map(p => [p.id, p]));
  const sections = [], terms = {}, hits = new Map(), byPiece = new Map();
  const secDicts = dictSections(dict);

  for (const [sid, map] of Object.entries(secDicts)) {
    const lang = sid.startsWith('lang:') ? sid.slice(5) : (sid === 'common' ? '' : sid);
    const markup = MARKUP.has(lang);
    const keys = Object.keys(map);
    const shapes = keys.map(k => termShape(k, lang));
    const stats = sectionStats(shapes);
    const T = Math.max(6, Math.ceil(keys.length * 0.004));
    const ctx = { T, freeCount: stats.freeCount, markup };
    const cand = piecesFor(sid, pieces);
    // обратный индекс токен → куски раздела, чтобы не гонять каждый ключ по каждому куску
    const inv = new Map();
    cand.forEach((p, idx) => { for (const t of p.pos.keys()) { let a = inv.get(t); if (!a) inv.set(t, a = []); a.push(idx); } });

    const secTerms = {}; let covered = 0, prose = 0, weak = 0, generic = 0;
    keys.forEach((key, ki) => {
      const sh = shapes[ki];
      const rec = { n: 0, ids: [], kind: 'word', note: map[key] };
      secTerms[key] = rec;
      if (sh.kind === 'prose') { rec.kind = 'prose'; prose++; return; }
      const shape = shapeOf(sh, ctx);
      if (!shape || !shape.lits.length) { rec.kind = 'weak'; weak++; return; }
      rec.kind = shape.mode === 'regex' ? (shape.generic ? 'generic' : 'construct') : 'word';
      if (rec.kind === 'generic') generic++;
      // кандидаты: куски, где есть все обязательные токены
      const lists = shape.lits.map(t => inv.get(t));
      if (lists.some(l => !l)) return;
      lists.sort((x, y) => x.length - y.length);
      let cl = lists[0];
      for (let i = 1; i < lists.length && cl.length; i++) { const st = new Set(lists[i]); cl = cl.filter(x => st.has(x)); }
      const ids = [];
      for (const idx of cl) {
        const pc = cand[idx];
        const ok = shape.mode === 'regex' ? shape.re.test(pc.text)
                 : shape.mode === 'window' ? windowMatch(pc, shape.lits, shape.lits.length + 3)
                 : true;
        if (ok) ids.push(pc.id);
      }
      rec.n = ids.length; rec.ids = ids.slice(0, 8);
      if (ids.length) {
        covered++; hits.set(sid + '\u0000' + key, ids);
        for (const id of ids) { let arr = byPiece.get(id); if (!arr) byPiece.set(id, arr = []); arr.push({ sid, term: key }); }
      }
    });
    terms[sid] = secTerms;
    const codeTotal = keys.length - prose - weak;
    sections.push({ id: sid, label: sectionLabel(sid), total: keys.length, checkable: codeTotal, covered, uncovered: codeTotal - covered, prose, weak, generic, pieces: cand.length });
  }

  const usage = {
    builtAt: Date.now(), ms: Date.now() - t0, pieceCount: pieces.length, sections, terms,
    piecesOf(sid, term) { return hits.get(sid + '\u0000' + term) || []; },
    pieceInfo(id) { const p = byId.get(id); return p ? { id: p.id, title: p.title, lang: p.lang, group: p.group } : null; },
    termsOfPiece(id) {
      const arr = byPiece.get(id) || [];
      return arr.map(({ sid, term }) => {
        const r = terms[sid][term]; const all = hits.get(sid + '\u0000' + term) || [];
        return { sid, term, kind: r.kind, n: all.length, note: r.note, others: all.filter(x => x !== id).slice(0, 8) };
      });
    },
    gaps(sid, { kinds } = {}) {
      const t = terms[sid] || {}; const want = kinds || ['word', 'construct', 'generic'];   // prose/weak — не код, в «пробелы» не попадают
      return Object.entries(t).filter(([, r]) => r.n === 0 && want.includes(r.kind)).map(([term, r]) => ({ term, note: r.note, kind: r.kind }));
    },
  };
  return usage;
}

// быстрый отпечаток библиотеки: меняется, когда меняется код любого куска
export function libraryFingerprint(entries) {
  let h = 2166136261 >>> 0, n = 0;
  for (const e of entries || []) {
    const s = String(e.id) + '\u0001' + String(e.lang || '') + '\u0001' + String(e.code || '');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    n++;
  }
  return n + ':' + h.toString(36);
}
