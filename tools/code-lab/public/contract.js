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
  window.contractParseItem = parseItem;
  window.contractTypeColor = typeColor;
  window.contractTypesCompatible = typesCompatible;
  window.contractCanonType = canonType;
})();
