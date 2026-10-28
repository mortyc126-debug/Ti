// Типизированный контракт: имя входа/выхода может нести тип — «имя: тип».
// Общий словарь типов (с синонимами и цветами), разбор и проверка совместимости.
// Подключать ПЕРЕД inventory.js / component.js / constructor.js.
(function(){
  // канон → {color, синонимы}
  const T = [
    { t:'число',   color:'#FF8800', kw:['число','числа','number','num','int','float','целое','дробное'] },
    { t:'строка',  color:'#52F2C9', kw:['строка','строки','string','str','текст','text'] },
    { t:'массив',  color:'#3DD9FF', kw:['массив','список','array','list','перечень'] },
    { t:'объект',  color:'#B45CFF', kw:['объект','object','obj','словарь','карточка','запись','map'] },
    { t:'булево',  color:'#FF2D78', kw:['булево','boolean','bool','флаг','да/нет','логическое'] },
    { t:'функция', color:'#9090BB', kw:['функция','function','func','колбэк','callback','обработчик'] },
    { t:'промис',  color:'#FF6B6B', kw:['промис','promise','async','await','ожидание'] },
    { t:'элемент', color:'#7C8CFF', kw:['элемент','dom','node','узел','тег'] },
    { t:'любое',   color:'#8A86A6', kw:['любое','any','что угодно','?','—'] }
  ];
  const byKw = {}; T.forEach(x => x.kw.forEach(k => byKw[k.toLowerCase()] = x.t));
  const byT = {}; T.forEach(x => byT[x.t] = x);
  // канонизировать слово типа → канон или '' если не распознан (оставим как есть)
  function canonType(s){ const q = String(s || '').trim().toLowerCase(); return byKw[q] || q; }
  // «имя: тип» → {name, type} (type канонизирован; '' если тип не указан)
  function parseItem(s){
    const str = String(s == null ? '' : s).trim();
    const i = str.indexOf(':');
    if(i < 0) return { name: str, type: '' };
    return { name: str.slice(0, i).trim(), type: canonType(str.slice(i + 1)) };
  }
  function typeColor(type){ const x = byT[canonType(type)]; return x ? x.color : '#8A86A6'; }
  // совместимы ли выход типа a и вход типа b: пустое/«любое» подходит к чему угодно
  function typesCompatible(a, b){
    const ca = canonType(a), cb = canonType(b);
    if(!ca || !cb || ca === 'любое' || cb === 'любое') return true;
    return ca === cb;
  }
  window.CONTRACT_TYPES = T.map(x => x.t);
  // имена «даёт/нужно» с подписью простыми словами (labels — с сервера: {имя: {text, kind, service, own}}).
  // Главные — первыми, служебные (i, a, результат) — приглушённо в конце; полная подпись — во всплывающей подсказке.
  var escH = function(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  if(!document.getElementById('ct-lbl-style')){
    var st = document.createElement('style'); st.id = 'ct-lbl-style';
    st.textContent = '.ct-l{display:inline-flex;flex-direction:column;vertical-align:top;margin:1px 8px 3px 0;max-width:240px}'
      + '.ct-l .ct-n{display:inline-flex;align-items:center;gap:4px}'
      + '.ct-l .ct-s{font-size:11px;line-height:1.35;color:var(--text3,#9c90c4);white-space:normal}'
      + '.ct-l.own .ct-s{color:var(--str,#52F2C9)}'
      + '.ct-l.svc{opacity:.5;max-width:160px}.ct-l.svc .ct-s{display:none}.ct-l.svc:hover{opacity:1}.ct-l.svc:hover .ct-s{display:block}';
    document.head.appendChild(st);
  }
  function labeledChips(arr, labels){
    if(!arr || !arr.length) return '';
    labels = labels || {};
    var items = arr.map(function(s){ var it = parseItem(s); var L = labels[it.name] || null; return { it: it, L: L, svc: !!(L && L.service) }; });
    items.sort(function(a, b){ return (a.svc ? 1 : 0) - (b.svc ? 1 : 0); });
    return items.map(function(x){
      var ty = x.it.type ? '<span class="ct-ty" style="color:' + typeColor(x.it.type) + ';border-color:' + typeColor(x.it.type) + '55">' + escH(x.it.type) + '</span>' : '';
      var txt = x.L && x.L.text ? x.L.text : '';
      return '<span class="ct-l' + (x.svc ? ' svc' : '') + (x.L && x.L.own ? ' own' : '') + '" title="' + escH(x.it.name + (txt ? ' — ' + txt : '') + (x.L && x.L.own ? '  (своя подпись)' : '')) + '">'
        + '<span class="ct-n">' + escH(x.it.name) + ty + '</span>' + (txt ? '<span class="ct-s">' + escH(txt) + '</span>' : '') + '</span>';
    }).join('');
  }
  window.contractLabeledChips = labeledChips;
  window.contractParseItem = parseItem;
  window.contractTypeColor = typeColor;
  window.contractTypesCompatible = typesCompatible;
  window.contractCanonType = canonType;
})();
