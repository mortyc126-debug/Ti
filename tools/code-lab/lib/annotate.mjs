// Автоподпись слов из единого словаря keyword-dict.json.
// Вынесено из code-lab-server.mjs, чтобы им пользовались и сервер, и хранилище библиотеки.

// look(слово) → пояснение из словаря для данного языка или null
export function makeLook(lang, dict){
  dict = dict || {};
  const W = dict.words || {}, TAGS = dict.htmlTags || {}, ATTRS = dict.htmlAttrs || {}, PROPS = dict.cssProps || {}, VALS = dict.cssVals || {};
  const L = String(lang || '').toLowerCase();
  return v => {
    const lw = String(v).toLowerCase();
    if(L === 'css') return PROPS[lw] || VALS[lw] || W[lw] || null;
    if(L === 'html' || L === 'htm') return TAGS[lw] || ATTRS[lw] || W[lw] || null;
    return W[lw] || null;
  };
}

// Проставить e (пояснение) токенам из словаря, не затирая уже вписанные вручную.
// keepEmpty: токен с e === '' считается «пользователь стёр пояснение» и не подписывается заново.
// Возвращает число проставленных.
export function annotateLines(lines, lang, dict, keepEmpty){
  const look = makeLook(lang, dict);
  let count = 0;
  for(const line of (lines || [])){ for(const tok of (line || [])){
    if(!tok || tok.e) continue;                       // уже есть пояснение — не трогаем
    if(keepEmpty && tok.e === '') continue;
    if(tok.k === 'sp' || tok.k === 'op' || tok.k === 'num' || tok.k === 'str' || tok.k === 'com') continue;
    const ex = look(tok.v); if(ex){ tok.e = ex; count++; }
  } }
  return count;
}
