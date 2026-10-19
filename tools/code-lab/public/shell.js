// Единая оболочка приложения: боковое меню + контент. Чтобы не дублировать
// разметку на каждой странице, скрипт берёт всё, что уже есть в <body>,
// кладёт в .app-main и слева приставляет меню. Активный пункт — по
// data-page у <body>. Подключать ПЕРЕД основным скриптом страницы.
(function(){
  // сгруппировано по тому, ЧТО ты делаешь: начать → смотреть куски → собирать → данные
  const PAGES = [
    { key:'home',        label:'Главная',      href:'/',                sect:'Старт' },
    { key:'start',       label:'С чего начать', href:'/start.html',      sect:'Старт' },
    { key:'learn',       label:'Обучение',     href:'/schema.html',     sect:'Старт' },
    { key:'inventory',   label:'Опись',        href:'/inventory.html',  sect:'Кусочки кода' },
    { key:'library',     label:'Библиотека',   href:'/library.html',    sect:'Кусочки кода' },
    { key:'catalog',     label:'Каталог',      href:'/catalog.html',    sect:'Кусочки кода' },
    { key:'constructor', label:'Конструктор',  href:'/constructor.html',sect:'Собирать' },
    { key:'recipes',     label:'Рецепты',      href:'/recipes.html',    sect:'Собирать' },
    { key:'data',        label:'Данные (загрузка)', href:'/schema-json.html', sect:'Данные' },
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

  // назад / вперёд по истории — путешествовать по разделам, не начиная сначала
  const hist = document.createElement('div'); hist.className = 'nav-hist';
  const back = document.createElement('button'); back.className = 'hist-b'; back.innerHTML = '← назад'; back.title = 'назад (предыдущий раздел)';
  const fwd = document.createElement('button'); fwd.className = 'hist-b'; fwd.innerHTML = 'вперёд →'; fwd.title = 'вперёд';
  back.onclick = () => history.back(); fwd.onclick = () => history.forward();
  hist.append(back, fwd); side.appendChild(hist);
  let lastSect = null;
  PAGES.forEach(p => {
    if(p.sect && p.sect !== lastSect){ const s = document.createElement('div'); s.className = 'sect'; s.textContent = p.sect; side.appendChild(s); lastSect = p.sect; }
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

  // перетягиваемая ширина меню — общая для всех страниц, запоминается
  let SW = 230; try { SW = +localStorage.getItem('codelab_side_w') || 230; } catch(_){}
  const applyW = () => app.style.setProperty('--side-w', SW + 'px');
  applyW();
  const gutter = document.createElement('div'); gutter.className = 'side-gutter'; gutter.title = 'потяни, чтобы изменить ширину меню';
  app.appendChild(gutter);
  gutter.addEventListener('pointerdown', e => {
    e.preventDefault(); gutter.classList.add('drag'); document.body.classList.add('dragging-side');
    const sx = e.clientX, s0 = SW;
    const mv = ev => { SW = Math.max(170, Math.min(460, s0 + (ev.clientX - sx))); applyW(); };
    const up = () => {
      gutter.classList.remove('drag'); document.body.classList.remove('dragging-side');
      document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
      try { localStorage.setItem('codelab_side_w', SW); } catch(_){}
    };
    document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
  });
  // двойной клик по границе — сброс к стандартной ширине
  gutter.addEventListener('dblclick', () => { SW = 230; applyW(); try { localStorage.setItem('codelab_side_w', SW); } catch(_){} });

  // авто-рост полей ввода: textarea подстраивает высоту под текст (до max-height, дальше — скролл)
  const grow = ta => {
    if(!ta || ta.tagName !== 'TEXTAREA' || ta.dataset.noGrow) return;
    const max = parseInt(getComputedStyle(ta).maxHeight) || 600;
    ta.style.height = 'auto';
    const h = Math.min(ta.scrollHeight + 2, max);
    ta.style.height = h + 'px';
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
  };
  document.addEventListener('input', e => grow(e.target));
  document.addEventListener('focusin', e => grow(e.target));
  // первичный проход для полей, появившихся динамически (инспектор, модалки, вставка)
  const scan = root => { if(!root || root.nodeType !== 1) return; if(root.tagName === 'TEXTAREA') grow(root); root.querySelectorAll && root.querySelectorAll('textarea').forEach(grow); };
  new MutationObserver(ms => ms.forEach(m => m.addedNodes && m.addedNodes.forEach(scan))).observe(document.body, { childList:true, subtree:true });
  scan(document.body);
})();
