// простые проверки по тексту, без настоящего парсера: незакрытые скобки, кавычки и комментарии.
// плюс — где в коде стоит имя, которого не хватает. используется песочницей и тестами.
(function(root){
  'use strict';
  // ── разбор скобок и кавычек (по тексту, без настоящего парсера) ──
  const PAIR = { '(': ')', '[': ']', '{': '}' }, CLOSE = { ')': '(', ']': '[', '}': '{' };
  function scanBrackets(code, lang){
    lang = String(lang || '').toLowerCase();
    if(['html', 'svg', 'txt', 'md', 'xml', ''].includes(lang)) return [];   // в разметке кавычки и скобки — обычный текст
    const s = String(code || ''), n = s.length, out = [], stack = [];
    const hash = ['python', 'bash', 'ruby', 'perl', 'r', 'powershell', 'yaml'].includes(lang);
    const slash = !hash;
    const css = lang === 'css';
    const lineAt = p => { let l = 0; for(let i = 0; i < p && i < n; i++) if(s.charCodeAt(i) === 10) l++; return l; };
    let prevSig = '';   // последний значимый символ — чтобы отличить «/» деления от начала регулярки
    for(let i = 0; i < n; i++){
      const c = s[i];
      if(hash && c === '#'){ while(i < n && s[i] !== '\n') i++; continue; }
      if(slash && c === '/' && s[i + 1] === '/' && !css){ while(i < n && s[i] !== '\n') i++; continue; }
      if(slash && c === '/' && s[i + 1] === '*'){ const e = s.indexOf('*/', i + 2); if(e < 0){ out.push({ from: i, to: i + 2, msg: 'комментарий /* не закрыт', line: lineAt(i) }); break; } i = e + 1; continue; }
      if(lang === 'python' && (s.startsWith('"""', i) || s.startsWith("'''", i))){ const q = s.slice(i, i + 3); const e = s.indexOf(q, i + 3); if(e < 0){ out.push({ from: i, to: i + 3, msg: 'строка ' + q + ' не закрыта', line: lineAt(i) }); break; } i = e + 2; prevSig = 'a'; continue; }
      if(c === '"' || c === "'" || (c === '`' && !hash)){
        let j = i + 1, ok = false;
        while(j < n){ const d = s[j]; if(d === '\\'){ j += 2; continue; } if(d === c){ ok = true; break; } if(d === '\n' && c !== '`') break; j++; }
        if(!ok){ out.push({ from: i, to: i + 1, msg: 'кавычка ' + c + ' не закрыта', line: lineAt(i) }); i = j; continue; }
        i = j; prevSig = 'a'; continue;
      }
      if(slash && !css && c === '/' && (prevSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prevSig))){
        let j = i + 1, cls = false, ok = false;
        while(j < n && s[j] !== '\n'){ const d = s[j]; if(d === '\\'){ j += 2; continue; } if(d === '[') cls = true; else if(d === ']') cls = false; else if(d === '/' && !cls){ ok = true; break; } j++; }
        if(ok){ i = j; prevSig = 'a'; continue; }
      }
      if(PAIR[c]) stack.push({ ch: c, pos: i });
      else if(CLOSE[c]){
        const top = stack[stack.length - 1];
        if(!top) out.push({ from: i, to: i + 1, msg: 'лишняя «' + c + '» — её никто не открывал', line: lineAt(i) });
        else if(top.ch !== CLOSE[c]){
          out.push({ from: top.pos, to: top.pos + 1, msg: '«' + top.ch + '» закрыта не той скобкой «' + c + '» (строка ' + (lineAt(i) + 1) + ')', line: lineAt(top.pos) });
          stack.pop();
        } else stack.pop();
      }
      if(!/\s/.test(c)) prevSig = /[\w$)\]]/.test(c) ? 'a' : c;
      if(out.length > 40) break;
    }
    stack.forEach(t => out.push({ from: t.pos, to: t.pos + 1, msg: '«' + t.ch + '» не закрыта — нет «' + PAIR[t.ch] + '»', line: lineAt(t.pos) }));
    return out.sort((a, b) => a.from - b.from);
  }

  // где в коде стоит имя: #id/.класс ищем как слово внутри строк (селектор), tbl:имя — как имя таблицы
  function namePositions(code, name){
    const s = String(code || ''); let w = String(name || ''), pre = '(^|[^\\w$.])';
    if(/^[#.]/.test(w)){ w = w.slice(1); pre = '(^|[^\\w-])'; }
    else if(w.startsWith('tbl:')) w = w.slice(4);
    if(!w) return [];
    const re = new RegExp(pre + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w$-])', 'gi');
    const out = []; let m;
    while((m = re.exec(s)) && out.length < 50){ const from = m.index + m[1].length; out.push({ from, to: from + w.length }); if(re.lastIndex === m.index) re.lastIndex++; }
    return out;
  }
  // что значит «не хватает» — по-человечески
  function needText(name){
    const n = String(name || '');
    if(n[0] === '#') return 'код ищет элемент с id="' + n.slice(1) + '", а в разметке его нет — добавь в HTML';
    if(n[0] === '.') return 'код ищет элементы с классом «' + n.slice(1) + '», а в разметке их нет';
    if(n.startsWith('tbl:')) return 'запрос берёт таблицу «' + n.slice(4) + '», но её нигде не создают';
    if(n.startsWith('--')) return 'используется CSS-переменная ' + n + ', но её нигде не задают';
    return '«' + n + '» используется, но нигде не объявлено: нет const/let/function с таким именем';
  }

  const api = { scanBrackets, namePositions, needText };
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CodeCheck = api;
})(typeof window !== 'undefined' ? window : this);
