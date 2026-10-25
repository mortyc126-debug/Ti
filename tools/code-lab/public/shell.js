// Единая оболочка приложения: боковое меню + контент. Чтобы не дублировать
// разметку на каждой странице, скрипт берёт всё, что уже есть в <body>,
// кладёт в .app-main и слева приставляет меню. Активный пункт — по
// data-page у <body>. Подключать ПЕРЕД основным скриптом страницы.
(function(){
  // сгруппировано по тому, ЧТО ты делаешь: начать → смотреть куски → собирать → данные
  const PAGES = [
    { key:'home',        label:'Главная',      href:'/',                sect:'Старт' },
    { key:'start',       label:'С чего начать', href:'/start.html',      sect:'Старт' },
    { key:'inventory',   label:'Опись',        href:'/inventory.html',  sect:'Кусочки кода' },
    { key:'library',     label:'Библиотека',   href:'/library.html',    sect:'Кусочки кода' },
    { key:'constructor', label:'Конструктор',  href:'/constructor.html',sect:'Собирать' },
    { key:'recipes',     label:'Рецепты',      href:'/recipes.html',    sect:'Собирать' },
    { key:'data',        label:'Куски кода', href:'/schema-json.html', sect:'Данные' },
  ];
  const cur = document.body.dataset.page || '';

  // как показывать названия «англ — рус»: по умолчанию русское вперёд (настраивается)
  function codelabTitle(title){
    try { if(localStorage.getItem('codelab_ru_first') === '0') return title; } catch(_){}
    const s = String(title == null ? '' : title);
    const parts = s.split(/\s+—\s+/);
    if(parts.length < 2) return s;
    const left = parts[0], rest = parts.slice(1).join(' — ');
    const hasRu = x => /[а-яё]/i.test(x);
    if(!hasRu(left) && hasRu(rest)) return rest + ' — ' + left;   // слева чистый англ, справа русский → поменять
    return s;
  }
  window.codelabTitle = codelabTitle;

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
  brand.innerHTML = '<span class="logo"></span>';
  const collapse = document.createElement('button'); collapse.className = 'side-collapse'; collapse.textContent = '⟨'; collapse.title = 'свернуть меню';
  brand.appendChild(collapse); side.appendChild(brand);

  // назад / вперёд по истории — путешествовать по разделам, не начиная сначала
  const hist = document.createElement('div'); hist.className = 'nav-hist';
  const back = document.createElement('button'); back.className = 'hist-b'; back.innerHTML = '← назад'; back.title = 'назад (предыдущий раздел)';
  const fwd = document.createElement('button'); fwd.className = 'hist-b'; fwd.innerHTML = 'вперёд →'; fwd.title = 'вперёд';
  back.onclick = () => history.back(); fwd.onclick = () => history.forward();
  hist.append(back, fwd); side.appendChild(hist);

  // общий поиск по всем кускам — из любого раздела
  const sbox = document.createElement('div'); sbox.className = 'side-search';
  const sin = document.createElement('input'); sin.className = 'ss-in'; sin.placeholder = '🔎 найти кусок…'; sin.spellcheck = false;
  const sres = document.createElement('div'); sres.className = 'ss-res'; sres.style.display = 'none';
  sbox.append(sin, sres); side.appendChild(sbox);
  sin.placeholder = '🔎 найти что угодно…';
  let ALL = null, DICT = null;
  const esc2 = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const loadAll = () => ALL || (ALL = fetch('/api/list').then(r => r.json()).catch(() => []));
  const loadDict = () => DICT || (DICT = fetch('/keyword-dict.json', { cache:'no-store' }).then(r => r.json()).catch(() => ({})));
  const give = t => (t.comp && t.comp.provides) || [], need = t => (t.comp && t.comp.requires) || [];
  // поиск по словарю (слова + языки + HTML/CSS + синонимы по смыслу)
  function dictSearch(d, q){
    const out = [], seen = new Set();
    const push = (term, text, where) => { const k = where + '|' + term; if(seen.has(k)) return; seen.add(k); out.push({ term, text: String(text || ''), where }); };
    const scan = (obj, where) => { if(!obj) return; for(const [k, v] of Object.entries(obj)){ if(typeof v !== 'string') continue; if(k.toLowerCase().includes(q) || v.toLowerCase().includes(q)) push(k, v, where); } };
    scan(d.words, 'слово'); ['htmlTags','htmlAttrs','cssProps','cssVals'].forEach(s => scan(d[s], s));
    if(d.langs) for(const l of Object.keys(d.langs)) scan(d.langs[l], l);
    if(d.synonyms){
      const explOf = t => { const lt = t.toLowerCase(); if(d.words && d.words[lt]) return d.words[lt]; for(const s of ['htmlTags','htmlAttrs','cssProps','cssVals']) if(d[s] && d[s][lt]) return d[s][lt]; if(d.langs) for(const l of Object.keys(d.langs)) if(d.langs[l][lt]) return d.langs[l][lt]; return ''; };
      for(const [term, syns] of Object.entries(d.synonyms)){ if(!Array.isArray(syns)) continue; const hit = syns.find(s => String(s).toLowerCase().includes(q)); if(hit) push(term, (explOf(term) || '(нет пояснения)') + '  ← ' + hit, 'синоним'); }
    }
    return out.slice(0, 12);
  }
  let drawSeq = 0;
  const draw = async () => {
    const q = sin.value.toLowerCase().trim();
    if(!q){ sres.style.display = 'none'; sres.innerHTML = ''; return; }
    const seq = ++drawSeq;
    sres.innerHTML = ''; let any = false;
    const grp = name => { const d = document.createElement('div'); d.className = 'ss-grp'; d.textContent = name; sres.appendChild(d); };
    const item = (href, title, tag) => { const a = document.createElement('a'); a.className = 'ss-item'; a.href = href; a.innerHTML = '<span class="ss-t">' + esc2(title) + '</span><span class="ss-g">' + esc2(tag) + '</span>'; sres.appendChild(a); any = true; };
    // 1) разделы программы
    const sects = PAGES.filter(p => (p.label + ' ' + (p.sect || '')).toLowerCase().includes(q)).slice(0, 5);
    if(sects.length){ grp('Разделы'); sects.forEach(p => item(p.href, p.label, 'раздел')); }
    // 2) куски
    const list = await loadAll(); if(seq !== drawSeq) return;
    const pieces = list.filter(t => ((t.title || '') + ' ' + (t.group || '') + ' ' + (t.lang || '') + ' ' + (t.desc || '') + ' ' + give(t).join(' ') + ' ' + need(t).join(' ')).toLowerCase().includes(q)).slice(0, 10);
    if(pieces.length){ grp('Куски'); pieces.forEach(t => item('/component.html?id=' + encodeURIComponent(t.id), codelabTitle(t.title || t.id), (t.group || '').split('/')[0].trim() + ' · ' + (t.lang || '').toUpperCase())); }
    // 3) словарь (+синонимы) — клик разворачивает пояснение прямо здесь, без перехода
    const d = await loadDict(); if(seq !== drawSeq) return;
    dictSearch(d, q).forEach((h, i) => { if(i === 0) grp('Словарь');
      const row = document.createElement('div'); row.className = 'ss-item ss-dict'; row.innerHTML = '<span class="ss-t">' + esc2(h.term) + '</span><span class="ss-g">' + esc2(h.where) + '</span>';
      const expl = document.createElement('div'); expl.className = 'ss-expl'; expl.style.display = 'none'; expl.textContent = h.text;
      row.onclick = () => { expl.style.display = expl.style.display === 'none' ? '' : 'none'; };
      sres.appendChild(row); sres.appendChild(expl); any = true;
    });
    // 4) рецепты и схемы
    const rc = await fetch('/api/recipes/list').then(r => r.json()).catch(() => []); if(seq !== drawSeq) return;
    const rh = (rc || []).filter(r => (r.name || r.title || '').toLowerCase().includes(q)).slice(0, 5);
    if(rh.length){ grp('Рецепты'); rh.forEach(r => item('/recipes.html', r.name || r.title || r.id, 'рецепт')); }
    const fl = await fetch('/api/flows/list').then(r => r.json()).catch(() => []); if(seq !== drawSeq) return;
    const fh = (fl || []).filter(f => (f.name || '').toLowerCase().includes(q)).slice(0, 5);
    if(fh.length){ grp('Схемы'); fh.forEach(f => item('/constructor.html', f.name || f.id, 'схема')); }
    if(!any) sres.innerHTML = '<div class="ss-grp">ничего не нашлось</div>';
    sres.style.display = '';
  };
  sin.addEventListener('input', draw);
  sin.addEventListener('focus', () => { if(sin.value.trim()) draw(); });
  sin.addEventListener('keydown', e => {
    if(e.key === 'Escape'){ sin.value = ''; sres.style.display = 'none'; }
    if(e.key === 'Enter'){ const first = sres.querySelector('a.ss-item[href]'); if(first) location.href = first.getAttribute('href'); }
  });
  document.addEventListener('click', e => { if(!sbox.contains(e.target)) sres.style.display = 'none'; });
  let lastSect = null;
  PAGES.forEach(p => {
    if(p.sect && p.sect !== lastSect){ const s = document.createElement('div'); s.className = 'sect'; s.textContent = p.sect; side.appendChild(s); lastSect = p.sect; }
    const a = document.createElement('a'); a.className = 'nav-i' + (p.key === cur ? ' on' : ''); a.href = p.href;
    a.textContent = p.label;
    side.appendChild(a);
  });
  const sp = document.createElement('div'); sp.className = 'spacer'; side.appendChild(sp);
  // переключатель порядка названий
  const ruf = document.createElement('label'); ruf.className = 'ru-first';
  const rufIn = document.createElement('input'); rufIn.type = 'checkbox';
  let rfOn = true; try { rfOn = localStorage.getItem('codelab_ru_first') !== '0'; } catch(_){}
  rufIn.checked = rfOn;
  rufIn.onchange = () => { try { localStorage.setItem('codelab_ru_first', rufIn.checked ? '1' : '0'); } catch(_){} location.reload(); };
  ruf.append(rufIn, document.createTextNode(' названия: сначала по-русски')); side.appendChild(ruf);
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
  const ts = document.createElement('script'); ts.src = '/theme.js'; document.head.appendChild(ts);
})();
