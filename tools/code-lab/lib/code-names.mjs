// свои имена в файле: где объявлены, что в них лежит и не опечатка ли.
//
//   analyzeNames(code, lang, { dict, explain, globals }) → { names: {имя: {kind, text, line}}, typos: [{name, maybe, line, kind}] }
//
// опечатка имени — имя используется, но нигде не объявлено, а объявленное очень похоже (btnn → btn).
// опечатка метода — после точки стоит то, чего нет ни в словаре, ни в файле, но похоже на известное (addEventListner).

const KW = new Set(('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await of static get set from as true false null undefined '
  + 'def elif except lambda pass raise with global nonlocal assert is not and or None True False print self cls').split(' '));

// строки и комментарии заменяем пробелами той же длины: так они не мешают, а позиции не съезжают
function blank(code, lang){
  const hash = /^(python|bash|ruby|r|perl|powershell)$/.test(lang);
  return String(code || '').replace(hash ? /#[^\n]*|'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g
    : /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, m => m.replace(/[^\n]/g, ' '));
}
const lineAt = (s, i) => { let n = 0; for(let k = 0; k < i; k++) if(s.charCodeAt(k) === 10) n++; return n; };

// расстояние Дамерау-Левенштейна (перестановка соседних букв — одна правка: addEventListner)
// сколько правок отделяет одно слово от другого: вставить, удалить, заменить букву или поменять две соседние местами.
// btnn → btn — 1 (удалить n), togle → toggle — 1 (вставить g), addEventListner → addEventListener — 1 (переставить).
// d[i][j] — сколько правок нужно, чтобы первые i букв a превратить в первые j букв b. таблица заполняется построчно,
// каждая клетка — минимум из «удалить», «вставить», «заменить» (и «переставить», если две буквы стоят наоборот).
// max — нам не нужно точное расстояние, только «≤ 1 или 2». если вся строка таблицы уже больше max,
// дальше считать бессмысленно — выходим сразу. на тысячах имён это сильно экономит.
function dist(a, b, max){
  if(Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for(let j = 1; j <= b.length; j++) d[0][j] = j;
  for(let i = 1; i <= a.length; i++){ let rowMin = Infinity;
    for(let j = 1; j <= b.length; j++){ const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if(i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]); }
    if(rowMin > max) return max + 1; }
  return d[a.length][b.length];
}
const near = (w, pool) => { const max = w.length >= 8 ? 2 : 1; let best = null, bd = max + 1; for(const p of pool){ if(p === w) return null; const x = dist(w.toLowerCase(), p.toLowerCase(), max); if(x < bd){ bd = x; best = p; } } return bd <= max && w.length >= 3 ? best : null; };

export function analyzeNames(code, lang, { dict = {}, explain = null, globals = new Set() } = {}){
  lang = String(lang || 'js').toLowerCase(); const L = lang === 'ts' ? 'js' : lang;
  const src = String(code || ''), b = blank(src, L);
  const ID = '[A-Za-zА-Яа-яЁё_$][\\wА-Яа-яЁё$]*';
  const decl = new Map();   // имя → строка объявления
  const put = (n, i) => { if(n && !KW.has(n) && !decl.has(n)) decl.set(n, lineAt(b, i)); };
  const each = (re, f) => { for(const m of b.matchAll(re)) f(m); };
  if(L === 'python'){
    each(new RegExp('(?:^|\\n)\\s*(?:async\\s+)?def\\s+(' + ID + ')\\s*\\(([^)]*)\\)', 'g'), m => { put(m[1], m.index); m[2].split(',').forEach(p => { const x = p.trim().match(new RegExp('^\\*{0,2}(' + ID + ')')); if(x) put(x[1], m.index); }); });
    each(new RegExp('(?:^|\\n)\\s*class\\s+(' + ID + ')', 'g'), m => put(m[1], m.index));
    each(new RegExp('(' + ID + ')\\s*=(?!=)', 'g'), m => put(m[1], m.index));
    each(new RegExp('for\\s+(' + ID + ')(?:\\s*,\\s*(' + ID + '))?\\s+in', 'g'), m => { put(m[1], m.index); put(m[2], m.index); });
    each(new RegExp('import\\s+(' + ID + ')|\\bas\\s+(' + ID + ')|from\\s+[\\w.]+\\s+import\\s+([^\\n]+)', 'g'), m => { put(m[1] || m[2], m.index); if(m[3]) m[3].split(',').forEach(x => put(x.trim().split(/\s+/)[0], m.index)); });
  } else {
    each(new RegExp('(?:const|let|var|function\\*?|class)\\s+(' + ID + ')', 'g'), m => put(m[1], m.index));
    each(new RegExp('(?:const|let|var)\\s*[{[]([^}\\]]*)[}\\]]', 'g'), m => m[1].split(',').forEach(p => { const x = p.trim().match(new RegExp('^(?:\\.\\.\\.)?(' + ID + ')(?:\\s*:\\s*(' + ID + '))?')); if(x) put(x[2] || x[1], m.index); }));
    each(new RegExp('function\\s*' + ID + '?\\s*\\(([^)]*)\\)', 'g'), m => m[1].split(',').forEach(p => { const x = p.trim().match(new RegExp('^(?:\\.\\.\\.)?(' + ID + ')')); if(x) put(x[1], m.index); }));
    each(/\(\s*([^()]*)\)\s*=>/g, m => m[1].split(',').forEach(p => { const x = p.trim().match(new RegExp('^(?:\\.\\.\\.)?(' + ID + ')')); if(x) put(x[1], m.index); }));
    each(new RegExp('(' + ID + ')\\s*=>', 'g'), m => put(m[1], m.index));
    each(new RegExp('catch\\s*\\(\\s*(' + ID + ')', 'g'), m => put(m[1], m.index));
    each(new RegExp('for\\s*\\(\\s*(?:const|let|var)\\s+(' + ID + ')', 'g'), m => put(m[1], m.index));
    each(new RegExp('import\\s+(' + ID + ')|import\\s*\\{([^}]*)\\}', 'g'), m => { put(m[1], m.index); if(m[2]) m[2].split(',').forEach(x => put(x.trim().split(/\s+as\s+/).pop(), m.index)); });
  }
  // что внутри своих имён — подписи из объявления и словаря
  const names = {};
  const info = explain ? explain(src, lang, [...decl.keys()]) : {};
  for(const [n, line] of decl) names[n] = { kind: (info[n] && info[n].kind) || 'имя', text: (info[n] && info[n].text) || '', line };

  // словарь: известные имена и методы (последнее звено ключей вида «obj.method»)
  const known = new Set(), methods = new Set();
  const take = o => { if(o) for(const k of Object.keys(o)){ for(const m of k.matchAll(/[A-Za-z_$][\w$]*/g)) known.add(m[0].toLowerCase()); for(const m of k.matchAll(/\.([A-Za-z_$][\w$]*)/g)) methods.add(m[1].toLowerCase()); } };
  take(dict.words); take(dict.langs && dict.langs[L]);
  // методы — с исходным регистром, если он есть в коде файла; иначе как в словаре
  const methodList = [...methods];

  const typos = []; const seenT = new Set();
  const declList = [...decl.keys()];
  for(const m of b.matchAll(new RegExp('(\\.)?(' + ID + ')', 'g'))){
    const [, dot, w] = m; const i = m.index + (dot ? 1 : 0);
    if(KW.has(w) || seenT.has(w)) continue;
    if(dot){
      // метод после точки: неизвестен ни словарю, ни файлу — ищем похожий известный
      if(methods.has(w.toLowerCase()) || known.has(w.toLowerCase()) || decl.has(w) || w.length < 5) continue;
      const maybe = near(w, methodList.filter(x => x.length >= 4));
      if(maybe){ seenT.add(w); typos.push({ name: w, maybe, line: lineAt(b, i), kind: 'метод' }); }
      continue;
    }
    if(decl.has(w) || globals.has(w) || known.has(w.toLowerCase())) continue;
    const maybe = near(w, declList);
    if(maybe){ seenT.add(w); typos.push({ name: w, maybe, line: lineAt(b, i), kind: 'имя', declLine: decl.get(maybe) }); }
  }
  return { names, typos };
}
