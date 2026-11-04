// Обработка маршрутов с карты данных.
// Если в URL есть ?open=dict|structure|word-relations|piece-links,
// Нажимаем соответствующую кнопку в Описи, чтобы открыть нужный инструмент.
(function(){
  const params = new URLSearchParams(location.search);
  const route = params.get('open');
  if(!route) return;

  const map = {
    dict: 'pdict',
    structure: 'pdictstruct',
    'word-relations': 'pdictrel',
    'piece-links': 'plinks'
  };

  const id = map[route];
  if(!id) return;

  const btn = document.getElementById(id);
  if(!btn) return;

  requestAnimationFrame(() => {
    btn.click();
  });
})();
