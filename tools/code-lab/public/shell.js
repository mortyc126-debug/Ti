// Единая оболочка приложения: боковое меню + контент. Чтобы не дублировать
// разметку на каждой странице, скрипт берёт всё, что уже есть в <body>,
// кладёт в .app-main и слева приставляет меню. Активный пункт — по
// data-page у <body>. Подключать ПЕРЕД основным скриптом страницы.
(function(){
  const PAGES = [
    { key:'home',        label:'Главная',     href:'/' },
    { key:'library',     label:'Библиотека',  href:'/library.html' },
    { key:'map',         label:'Карта',       href:'/map.html' },
    { key:'constructor', label:'Конструктор', href:'/constructor.html' },
    { key:'data',        label:'Данные',      href:'/schema-json.html' },
    { key:'learn',       label:'Обучение',    href:'/schema.html' },
  ];
  const cur = document.body.dataset.page || '';

  // переносим текущее содержимое страницы (кроме скриптов) в .app-main
  const main = document.createElement('div'); main.className = 'app-main';
  [...document.body.childNodes].forEach(n => {
    if(n.nodeType === 1 && n.tagName === 'SCRIPT') return;
    main.appendChild(n);
  });

  // на верхнеуровневых страницах старый ряд вкладок дублирует меню — убираем.
  // на страницах «Обучение» вкладки оставляем как под-навигацию разделов.
  if(cur !== 'learn'){ const t = main.querySelector('header .tabs'); if(t) t.remove(); }

  const side = document.createElement('aside'); side.className = 'side';
  side.innerHTML = '<div class="brand"><span class="logo"></span><span>Лаборатория</span></div>';
  PAGES.forEach(p => {
    const a = document.createElement('a'); a.className = 'nav-i' + (p.key === cur ? ' on' : ''); a.href = p.href;
    a.textContent = p.label;
    side.appendChild(a);
  });
  const sp = document.createElement('div'); sp.className = 'spacer'; side.appendChild(sp);
  const srv = document.createElement('div'); srv.className = 'srv';
  srv.innerHTML = '<span class="dot"></span><span>Локальный сервер · запущен</span>';
  side.appendChild(srv);

  const app = document.createElement('div'); app.className = 'app';
  app.appendChild(side); app.appendChild(main);
  document.body.insertBefore(app, document.body.firstChild);
})();
