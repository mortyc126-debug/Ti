// связи частей кода: когда, если, иначе, для каждого, потом, при ошибке, откуда, куда, результат.
// связь — свойство слова языка, а не конкретного куска, поэтому библиотеку размечать не нужно.
// откуда берётся: моя правка (dict.relations) → ядро языка (CORE ниже) → начало пояснения в словаре.
// этот же файл подключает сервер — для тестов и промпта ии.
(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.codelabLinks = api;
})(typeof self !== 'undefined' ? self : this, function(){
  const RELS = ['когда', 'если', 'иначе', 'для каждого', 'потом', 'при ошибке', 'откуда', 'куда', 'результат'];

  // ядро: слова, которыми язык выражает связи. Остальное собирается из них — описывать конструкции не нужно
  const CORE = {
    js: { if: 'если', 'else if': 'если', switch: 'если', case: 'если', '?': 'если', else: 'иначе', default: 'иначе',
      for: 'для каждого', while: 'для каждого', do: 'для каждого', forEach: 'для каждого', map: 'для каждого', filter: 'для каждого', reduce: 'для каждого', some: 'для каждого', every: 'для каждого', find: 'для каждого',
      await: 'потом', then: 'потом', async: 'потом', finally: 'потом',
      try: 'при ошибке', catch: 'при ошибке', throw: 'при ошибке',
      return: 'результат', yield: 'результат',
      addEventListener: 'когда', setTimeout: 'когда', setInterval: 'когда', requestAnimationFrame: 'когда', onclick: 'когда', oninput: 'когда', onload: 'когда' },
    python: { if: 'если', elif: 'если', match: 'если', case: 'если', else: 'иначе',
      for: 'для каждого', while: 'для каждого', await: 'потом', async: 'потом', finally: 'потом',
      try: 'при ошибке', except: 'при ошибке', raise: 'при ошибке', return: 'результат', yield: 'результат',
      open: 'откуда', input: 'откуда', import: 'откуда', print: 'куда' },
    css: { ':hover': 'когда', ':focus': 'когда', ':active': 'когда', ':checked': 'когда', ':focus-visible': 'когда', ':focus-within': 'когда', transition: 'когда', animation: 'когда',
      '@media': 'если', '@supports': 'если', '@container': 'если', ':not': 'если', ':has': 'если', ':is': 'если', ':where': 'если',
      ':nth-child': 'для каждого', ':nth-of-type': 'для каждого', 'var': 'откуда', 'url': 'откуда', '@import': 'откуда' },
    html: { onclick: 'когда', oninput: 'когда', onchange: 'когда', onsubmit: 'когда', onload: 'когда', src: 'откуда', href: 'куда', action: 'куда', form: 'куда', 'for': 'куда' },
  };
  CORE.ts = CORE.js;

  // сортировка по пояснению: смотрим только начало («получить…», «вывести…», «при клике…») — по всему тексту шумит
  const BY_NOTE = [
    ['при ошибке', /^(?:поймать|перехватить|обработать ошибк|обработка ошибк|выбросить|бросить|сгенерировать исключ|возбудить|при ошибке)/],
    ['когда', /^(?:при |когда |обработчик|подписаться|слушать|отписаться|запустить через|выполнить через|вызвать через|вызывать каждые|повторять каждые|запланировать|по таймеру|по событию)/],
    ['если', /^(?:если|проверить|проверка|проверяет|сравнить|условие|условн|выбрать ветку|ветвлени)/],
    ['иначе', /^иначе/],
    ['для каждого', /^(?:перебрать|перебор|для каждого|повторить|повторять|цикл|преобразовать каждый|отфильтровать|найти первый|пройти по|обойти)/],
    ['потом', /^(?:дождаться|ждать|подождать|после |затем|асинхрон|приостановить)/],
    ['результат', /^(?:вернуть|возвращает|вернёт|выдать результат)/],
    ['куда', /^(?:вывести|показать|отобразить|записать|вставить|добавить|отправить|сохранить|напечатать|установить|задать|изменить|поменять|заменить|очистить|удалить)/],
    ['откуда', /^(?:получить|прочитать|загрузить|найти|взять|выбрать|запросить|считать|узнать|достать|извлечь|импортировать)/],
  ];
  // в CSS/HTML «задать/выбрать» — это само оформление, а не поток данных: там по пояснению только когда/если/повтор
  const MARKUP_OK = new Set(['когда', 'если', 'для каждого', 'при ошибке']);
  function byNote(note, lang){
    const s = String(note || '').trim().toLowerCase().replace(/^[^—]{1,60}—\s*/, '').replace(/^[^а-яё]{1,80}:\s+/, ''); if(!s) return '';
    const markup = /^(css|html|htm|svg)$/.test(String(lang || '').toLowerCase());
    for(const [rel, re] of BY_NOTE) if(re.test(s)) return markup && !MARKUP_OK.has(rel) ? '' : rel;
    return '';
  }

  // связь слова: правка пользователя → ядро языка → пояснение словаря
  function relationOf(term, lang, dict, note){
    const l = String(lang || '').toLowerCase(), t = String(term || '').trim(); if(!t) return null;
    const lt = t.toLowerCase(), last = lt.replace(/^.*\./, '');
    const user = (dict && dict.relations) || {};
    for(const scope of [user[l], user['*']]) if(scope){ const v = scope[lt] != null ? scope[lt] : scope[last]; if(v != null) return { rel: v, from: 'правка' }; }   // пустая правка (rel '') — «связи нет»
    const core = CORE[l] || CORE.js; const want = [lt, last, ':' + lt, '@' + lt]; const ck = Object.keys(core).find(k => want.includes(k.toLowerCase()));   // в CSS «hover» из :hover, «media» из @media
    if(ck) return { rel: core[ck], from: 'ядро' };
    const r = byNote(note, l); return r ? { rel: r, from: 'пояснение' } : null;
  }

  // вложенность: строка → глубина по скобкам {} (и отступам — для Python), чтобы показать «внутри чего»
  function depths(code, lang){
    const lines = String(code || '').split('\n'); const out = [];
    if(/^py/i.test(String(lang || ''))){ const ind = []; for(const l of lines){ if(!l.trim()){ out.push(out.length ? out[out.length - 1] : 0); continue; }
      const n = l.match(/^\s*/)[0].replace(/\t/g, '    ').length; while(ind.length && ind[ind.length - 1] >= n) ind.pop(); out.push(ind.length); ind.push(n); } return out; }
    let d = 0;
    for(const l of lines){ const s = l.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '').replace(/\/\/.*$/, ''); const lead = (s.match(/^\s*[}\])]+/) || [''])[0].replace(/\s/g, '').length;
      out.push(Math.max(0, d - lead)); for(const c of s){ if(c === '{' || c === '(' || c === '[') d++; else if(c === '}' || c === ')' || c === ']') d = Math.max(0, d - 1); } }
    return out;
  }

  return { RELS, CORE, byNote, relationOf, depths };
});
