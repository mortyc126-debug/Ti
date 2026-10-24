// Токенайзер «Лаборатории кода»: сырой код → строки токенов {k, v, r?}.
// Вынесен из code-lab-server.mjs в отдельный модуль, чтобы его можно было
// тестировать без запуска сервера (tests/tokenizer.test.mjs).
//
// Виды токенов (k): kw — ключевое слово, fn — функция, name — имя (редактируемое,
// r — ссылка для синхронного переименования), num, str, com, op, sp.
//
// Что исправлено по сравнению с прежней версией:
//  • имена на любом языке (кириллица и др.): раньше «база» рассыпалась на б·а·з·а;
//  • CSS: font-family, grid-template-columns, --bg, -webkit-box — одним токеном
//    (раньше резались по дефису, и словарь cssProps для них не срабатывал);
//    цвета #140A24 — число; комментарии /* … */ (раньше как комментарий понимался «//»,
//    и url(https://…) обрывался);
//  • многострочные /* … */, `…` (JS) и """…""" / '''…''' (Python) продолжаются на следующих
//    строках, а не раскрашиваются как код;
//  • символы вне BMP (эмодзи) не рассыпаются на половинки суррогатной пары.

const KW = {
  js: new Set(['const','let','var','function','return','if','else','for','while','of','in','new','await','async','import','export','from','default','class','extends','super','try','catch','finally','throw','typeof','instanceof','null','undefined','true','false','this','break','continue','switch','case','do','yield','delete','void']),
  python: new Set(['def','return','if','elif','else','for','while','in','not','and','or','import','from','as','class','try','except','finally','raise','with','lambda','None','True','False','pass','break','continue','yield','global','nonlocal','del','assert','is','async','await']),
  sql: new Set(['select','from','where','group','by','order','having','join','left','right','inner','outer','full','cross','on','as','and','or','not','in','is','null','insert','into','values','update','set','delete','create','table','view','index','primary','key','foreign','references','distinct','count','sum','avg','min','max','case','when','then','else','end','limit','offset','union','all','with','desc','asc','between','like','exists']),
};
const BUILTIN = {
  js: new Set(['console','log','Math','JSON','Array','Object','String','Number','parseInt','parseFloat','fetch','document','window','map','filter','reduce','forEach','push','length','pow','sqrt','round','floor','random']),
  python: new Set(['print','range','len','int','float','str','list','dict','tuple','set','input','sum','min','max','abs','round','enumerate','zip','sorted','map','filter','open']),
  sql: new Set(),
};

// однострочный комментарий; null — у языка его нет (CSS)
function lineComment(lang){ return lang === 'sql' ? '--' : lang === 'python' ? '#' : lang === 'css' ? null : '//'; }
// языки с блочными комментариями /* … */
const BLOCK_LANGS = new Set(['css', 'js', 'javascript', 'ts', 'typescript', 'sql']);
const JS_LANGS = new Set(['js', 'javascript', 'ts', 'typescript']);

// идентификатор — любые буквы Unicode (+ _ и $), дальше ещё и цифры
const ID_RE = /^[\p{ID_Start}_$][\p{ID_Continue}$‌‍]*/u;
// в CSS в имени допустим дефис: font-family, --bg, -webkit-box
const CSS_ID_RE = /^(?:--|-(?=[\p{ID_Start}_]))?[\p{ID_Start}_][\p{ID_Continue}‌‍-]*/u;
// цвет #fff / #ffff / #ffffff / #ffffffff; не цвет, если дальше букв нет и это не селектор «#abc {»
const HEX_RE = /^#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\p{ID_Continue}-])(?!\s*\{)/u;

// позиция сразу за закрывающей последовательностью q (с учётом \-экранирования) или -1
function findClose(line, from, q){
  for(let j = from; j < line.length; j++){
    if(line[j] === '\\'){ j++; continue; }
    if(line.startsWith(q, j)) return j + q.length;
  }
  return -1;
}

// st — состояние между строками: st.mode = null | 'block' | 'tpl' | 'tdq' | 'tsq'
function tokenizeLine(line, lang, st){
  lang = String(lang || '').toLowerCase();
  st = st || {};
  const kws = KW[lang] || KW.js;
  const builtins = BUILTIN[lang] || BUILTIN.js;
  const lc = lineComment(lang);
  const blocks = BLOCK_LANGS.has(lang);
  const isJs = JS_LANGS.has(lang);
  const out = [];
  const n = line.length;
  let i = 0;

  // конструкция, начатая на прошлой строке (комментарий /* … */, `…`, """…""")
  if(st.mode){
    const ws = /^\s*/.exec(line)[0];
    if(ws){ out.push({ k: 'sp', v: ws }); i = ws.length; }
    let end;
    if(st.mode === 'block'){ const x = line.indexOf('*/', i); end = x < 0 ? -1 : x + 2; }
    else end = findClose(line, i, st.mode === 'tpl' ? '`' : st.mode === 'tdq' ? '"""' : "'''");
    const kind = st.mode === 'block' ? 'com' : 'str';
    if(end < 0){ if(i < n) out.push({ k: kind, v: line.slice(i) }); return out; }
    out.push({ k: kind, v: line.slice(i, end) }); i = end; st.mode = null;
  }

  while(i < n){
    const rest = line.slice(i);
    const c = line[i];
    if(lc && rest.startsWith(lc)){ out.push({ k: 'com', v: line.slice(i) }); break; }
    if(blocks && rest.startsWith('/*')){
      const x = line.indexOf('*/', i + 2);
      if(x < 0){ out.push({ k: 'com', v: line.slice(i) }); st.mode = 'block'; break; }
      out.push({ k: 'com', v: line.slice(i, x + 2) }); i = x + 2; continue;
    }
    if(lang === 'python' && (rest.startsWith('"""') || rest.startsWith("'''"))){
      const q = rest.slice(0, 3), e = findClose(line, i + 3, q);
      if(e < 0){ out.push({ k: 'str', v: line.slice(i) }); st.mode = q === '"""' ? 'tdq' : 'tsq'; break; }
      out.push({ k: 'str', v: line.slice(i, e) }); i = e; continue;
    }
    if(c === '"' || c === "'" || (isJs && c === '`')){
      let j = i + 1, closed = false;
      while(j < n){ if(line[j] === '\\'){ j += 2; continue; } if(line[j] === c){ j++; closed = true; break; } j++; }
      out.push({ k: 'str', v: line.slice(i, j) }); i = j;
      if(!closed && c === '`') st.mode = 'tpl';   // шаблонная строка продолжается на следующих строках
      continue;
    }
    if(/[0-9]/.test(c)){ const m = /^(0x[0-9a-fA-F]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?)/.exec(rest); if(m){ out.push({ k: 'num', v: m[0] }); i += m[0].length; continue; } }
    if(lang === 'css' && c === '#'){ const hm = HEX_RE.exec(rest); if(hm){ out.push({ k: 'num', v: hm[0] }); i += hm[0].length; continue; } }
    const im = (lang === 'css' ? CSS_ID_RE : ID_RE).exec(rest);
    if(im){
      const w = im[0];
      const key = lang === 'sql' ? w.toLowerCase() : w;
      let k = i + w.length; while(k < n && line[k] === ' ') k++;
      if(kws.has(key)) out.push({ k: 'kw', v: w });
      else if(line[k] === '(' || builtins.has(w)) out.push({ k: 'fn', v: w });
      else out.push({ k: 'name', v: w, r: w });   // имя → редактируемое, ref=само слово (переименование синхронно)
      i += w.length; continue;
    }
    const ws = /^\s+/.exec(rest);
    if(ws){ out.push({ k: 'sp', v: ws[0] }); i += ws[0].length; continue; }
    const ch = String.fromCodePoint(line.codePointAt(i));   // целый символ, не половинка суррогатной пары
    out.push({ k: 'op', v: ch }); i += ch.length;
  }
  return out;
}

export function tokenize(code, lang){
  const st = {};
  return String(code).replace(/\r\n/g, '\n').split('\n').map(l => tokenizeLine(l, lang, st));
}
export { tokenizeLine };
