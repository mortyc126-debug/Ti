// Единая оболочка приложения: боковое меню + контент. Чтобы не дублировать
// разметку на каждой странице, скрипт берёт всё, что уже есть в <body>,
// кладёт в .app-main и слева приставляет меню. Активный пункт — по
// data-page у <body>. Подключать ПЕРЕД основным скриптом страницы.
(function(){
  const PAGES = [
    { key:'home',        label:'Главная',     href:'/' },
    { key:'library',     label:'Библиотека',  href:'/library.html' },
    { key:'catalog',     label:'Каталог',     href:'/catalog.html' },
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
  const brand = document.createElement('div'); brand.className = 'brand';
  brand.innerHTML = '<span class="logo"></span><span class="brand-t">Лаборатория</span>';
  const collapse = document.createElement('button'); collapse.className = 'side-collapse'; collapse.textContent = '⟨'; collapse.title = 'свернуть меню';
  brand.appendChild(collapse); side.appendChild(brand);
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

  // кнопка-открывашка, видна когда меню свёрнуто
  const reopen = document.createElement('button'); reopen.className = 'side-reopen'; reopen.textContent = '☰'; reopen.title = 'показать меню';
  app.appendChild(reopen);

  document.body.insertBefore(app, document.body.firstChild);

  // сворачивание меню, состояние запоминается на всех страницах
  let off = false; try { off = localStorage.getItem('codelab_shell_side') === 'off'; } catch(_){}
  const apply = () => app.classList.toggle('side-off', off);
  apply();
  const toggle = v => { off = v; try { localStorage.setItem('codelab_shell_side', off ? 'off' : 'on'); } catch(_){} apply(); };
  collapse.onclick = e => { e.preventDefault(); toggle(true); };
  reopen.onclick = e => { e.preventDefault(); toggle(false); };
})();
