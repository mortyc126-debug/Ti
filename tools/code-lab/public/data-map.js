// Навигация с карты данных к существующим инструментам Описи.
// Ссылки содержат только поддерживаемый параметр ?open=; незавершённые ?step= удаляются.
(function(){
  const actions = {
    dict: ['pdict', 'словарь пояснений'],
    structure: ['pdictstruct', 'правила структуры'],
    'word-relations': ['pdictrel', 'связи слов'],
    'piece-links': ['plinks', 'связи из текста']
  };
  document.querySelectorAll('.data-map a[href*="open="]').forEach(link => {
    const url = new URL(link.href, location.href);
    const route = url.searchParams.get('open');
    const action = actions[route];
    if(!action) return;
    link.href = '/inventory.html?open=' + encodeURIComponent(route);
    link.title = 'Перейти в Опись и открыть кнопку «' + action[1] + '»';
  });
})();
