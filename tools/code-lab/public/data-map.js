// Навигация карты данных: ссылки ведут к существующим кнопкам Описи,
// а не к несуществующим режимам открытия модальных окон.
(function(){
  const side = document.querySelector('.side');
  if(side && !side.querySelector('[data-map-nav]')){
    const link = document.createElement('a');
    link.className = 'nav-i on';
    link.href = '/data-map.html';
    link.textContent = 'Карта данных';
    link.dataset.mapNav = '1';
    const startLink = [...side.querySelectorAll('.nav-i')].find(a => a.getAttribute('href') === '/start.html');
    if(startLink) startLink.after(link);
    else side.appendChild(link);
  }

  const actionTargets = {
    dict: 'pdict',
    structure: 'pdictstruct',
    'word-relations': 'pdictrel',
    'piece-links': 'plinks'
  };
  document.querySelectorAll('.data-map a[href*="open="]').forEach(link => {
    const url = new URL(link.href, location.href);
    const route = url.searchParams.get('open');
    const target = actionTargets[route];
    if(!target) return;
    link.href = '/inventory.html#' + target;
    link.title = 'Перейти к кнопке «' + ({
      pdict: 'словарь пояснений',
      pdictstruct: 'правила структуры',
      pdictrel: 'связи слов',
      plinks: 'связи из текста'
    }[target]) + '» в Описи';
  });
})();
