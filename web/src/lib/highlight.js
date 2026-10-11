// Лёгкий токенайзер для подсветки кода без внешних зависимостей (prism/hljs не
// тянем — тут хватает). Разбирает JS/Python/SQL на токены; цвет берём из той же
// индикаторной палитры, что и везде. Строки маленькие (шаблоны), поэтому
// per-loop slice ок по скорости.
import { INDICATOR_COLORS as C } from './indicatorColors.js';

const KW = {
  js: ['const','let','var','function','return','if','else','for','while','of','in','new','await','async','import','export','from','default','class','extends','super','try','catch','finally','throw','typeof','instanceof','null','undefined','true','false','this','break','continue','switch','case','do','yield','delete','void'],
  python: ['def','return','if','elif','else','for','while','in','not','and','or','import','from','as','class','try','except','finally','raise','with','lambda','None','True','False','pass','break','continue','yield','global','nonlocal','del','assert','is','async','await'],
  sql: ['select','from','where','group','by','order','having','join','left','right','inner','outer','full','cross','on','as','and','or','not','in','is','null','insert','into','values','update','set','delete','create','table','view','index','primary','key','foreign','references','distinct','count','sum','avg','min','max','case','when','then','else','end','limit','offset','union','all','with','desc','asc','between','like','exists'],
};

export function tokenize(code, lang){
  const kws = new Set(KW[lang] || KW.js);
  const out = [];
  const push = (type, value) => out.push({ type, value });
  const n = code.length;
  const lineC = lang === 'sql' ? '--' : lang === 'python' ? '#' : '//';
  let i = 0;
  while(i < n){
    const rest = code.slice(i);
    const c = code[i];
    // строчный комментарий
    if(rest.startsWith(lineC)){ let j = code.indexOf('\n', i); if(j < 0) j = n; push('comment', code.slice(i, j)); i = j; continue; }
    // блочный комментарий (js)
    if(lang === 'js' && rest.startsWith('/*')){ let j = code.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; push('comment', code.slice(i, j)); i = j; continue; }
    // тройные строки python
    if(lang === 'python' && (rest.startsWith('"""') || rest.startsWith("'''"))){ const q = rest.slice(0, 3); let j = code.indexOf(q, i + 3); j = j < 0 ? n : j + 3; push('string', code.slice(i, j)); i = j; continue; }
    // обычная строка
    if(c === '"' || c === "'" || (lang === 'js' && c === '`')){
      let j = i + 1; while(j < n){ if(code[j] === '\\'){ j += 2; continue; } if(code[j] === c){ j++; break; } j++; }
      push('string', code.slice(i, j)); i = j; continue;
    }
    // число
    if(/[0-9]/.test(c)){ const m = /^(0x[0-9a-fA-F]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?)/.exec(rest); if(m){ push('number', m[0]); i += m[0].length; continue; } }
    // идентификатор / ключевое слово / вызов функции
    const im = /^[A-Za-z_$][\w$]*/.exec(rest);
    if(im){
      const w = im[0];
      const key = lang === 'sql' ? w.toLowerCase() : w;
      let k = i + w.length; while(k < n && code[k] === ' ') k++;
      if(kws.has(key)) push('keyword', w);
      else if(code[k] === '(') push('fn', w);
      else push('ident', w);
      i += w.length; continue;
    }
    // пробелы
    const ws = /^\s+/.exec(rest);
    if(ws){ push('ws', ws[0]); i += ws[0].length; continue; }
    // прочее — оператор/пунктуация
    push('op', c); i++;
  }
  return out;
}

// Цвета токенов. ident — светлый текст, op — приглушённый фиолет (как var(--text3)).
export const TOKEN_COLOR = {
  comment: C.gray,
  string:  C.bullish,
  number:  C.orange,
  keyword: C.violet,
  fn:      C.blue,
  ident:   '#CBC2EA',
  op:      '#9C90C4',
};
