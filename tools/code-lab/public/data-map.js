// Навигация с карты данных к существующим инструментам Описи.
// Ссылки остаются рабочими и без JavaScript: fragment прокручивает к кнопке.
(function(){
  const side = document.querySelector('.side');
  if(side && !side.querySelector('[data-map-nav]')){
    const link = document.createElement('a');
    link.className = 'nav-i';
    link.href = '/data-map.html';
    link.textContent = 'Карта данных';
    link.dataset.mapNav = '1';
    const startLink = [...side.querySelectorAll('.nav-i')].find(a => a.getAttribute('href') === '/start.html');
    if(startLink) startLink.after(link);
    else side.appendChild(link);
  }

  const actionTargets = {
    dict: ['pdict', 'словарь пояснений'],
    structure: ['pdictstruct', 'правила структуры'],
    'word-relations': ['pdictrel', 'связи слов'],
    'piece-links': ['plinks', 'связи из текста']
  };

  document.querySelectorAll('.data-map a[href*="open="]').forEach(link => {
    const url = new URL(link.href, location.href);
    const action = actionTargets[url.searchParams.get('open')];
    if(!action) return;
    link.href = '/inventory.html?open=' + encodeURIComponent(url.searchParams.get('open'));
    link.title = 'Перейти к кнопке «' + action[1] + '» в Описи. Нажми её, чтобы открыть форму.';
  });
})();
