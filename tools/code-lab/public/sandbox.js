// Песочница внутри конструктора: панели-файлы на разных языках + живой предпросмотр.
// Фронтенд (html/css/js) собирается в iframe и перерисовывается при вводе; прочие
// языки (python и т.д.) запускаются на локальном сервере через /api/run, вывод — в консоль.
(function(){
  const center = document.querySelector('.center'); if(!center) return;

  // языки панелей: frontend рисуются в превью, остальные запускаются на сервере
  const LANGS = [
    { v:'html', t:'HTML', front:true },
    { v:'css',  t:'CSS',  front:true },
    { v:'js',   t:'JS',   front:true },
    { v:'python', t:'Python' },
    { v:'sql',  t:'SQL' },
    { v:'json', t:'JSON' },
    { v:'txt',  t:'текст' },
    { v:'ruby', t:'Ruby' }, { v:'php', t:'PHP' }, { v:'go', t:'Go' },
    { v:'ts', t:'TypeScript' }, { v:'bash', t:'Bash' }, { v:'lua', t:'Lua' }, { v:'r', t:'R' }
  ];
  const isFront = v => { const l = LANGS.find(x => x.v === v); return l && l.front; };
  const langName = v => { const l = LANGS.find(x => x.v === v); return l ? l.t : v; };

  const DEFAULTS = [
    { id:'f1', name:'index.html', lang:'html', code:'<h1>Привет!</h1>\n<p>Меняй код слева — превью обновится само.</p>\n<button id="b">нажми</button>' },
    { id:'f2', name:'style.css', lang:'css', code:'body{ font-family:system-ui, sans-serif; padding:24px; background:#0E0720; color:#eee }\nh1{ color:#52F2C9 }\nbutton{ padding:8px 14px; border-radius:8px; border:0; background:#FF006E; color:#fff; cursor:pointer }' },
    { id:'f3', name:'script.js', lang:'js', code:'document.getElementById("b").addEventListener("click", () => {\n  console.log("кнопка нажата");\n  document.querySelector("p").textContent = "Готово ✓";\n});' }
  ];

  let files = [];
  try { const s = JSON.parse(localStorage.getItem('codelab_sandbox') || 'null'); if(Array.isArray(s) && s.length) files = s; } catch(_){}
  if(!files.length) files = DEFAULTS.map(f => ({ ...f }));
  let live = true;
  try { live = localStorage.getItem('codelab_sandbox_live') !== '0'; } catch(_){}

  const save = () => { try { localStorage.setItem('codelab_sandbox', JSON.stringify(files)); } catch(_){} };
  const uid = () => 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  // ── DOM песочницы ──
  const box = document.createElement('div');
  box.className = 'sandbox'; box.id = 'sandbox'; box.style.display = 'none';
  box.innerHTML =
    '<div class="sb-eds" id="sbEds"></div>' +
    '<div class="sb-gut" id="sbGut" title="потяни — шире редактор или превью"></div>' +
    '<div class="sb-right">' +
      '<div class="sb-bar">' +
        '<button class="btn ok" id="sbRun">▶ запустить</button>' +
        '<label class="sb-live"><input type="checkbox" id="sbLive"> живой предпросмотр</label>' +
        '<button class="btn" id="sbAdd">+ файл</button>' +
        '<button class="btn" id="sbExplain" title="режим разбора: кликай по цветным словам в коде — объясню, что это">🔍 разбор</button>' +
        '<span style="flex:1"></span>' +
        '<button class="btn" id="sbClr">× консоль</button>' +
      '</div>' +
      '<iframe class="sb-frame" id="sbFrame" sandbox="allow-scripts allow-modals"></iframe>' +
      '<pre class="sb-con" id="sbCon"></pre>' +
    '</div>';
  center.appendChild(box);

  const edsEl = box.querySelector('#sbEds'), frame = box.querySelector('#sbFrame'), conEl = box.querySelector('#sbCon');
  const liveIn = box.querySelector('#sbLive'); liveIn.checked = live;

  // ── сборка документа для превью из frontend-файлов ──
  function buildDoc(){
    const html = files.filter(f => f.lang === 'html').map(f => f.code).join('\n');
    const css = files.filter(f => f.lang === 'css').map(f => f.code).join('\n');
    const js = files.filter(f => f.lang === 'js' || f.lang === 'ts').map(f => f.code).join('\n;\n');
    const cap = '<scr' + 'ipt>(function(){function s(t,a){try{parent.postMessage({__sb:1,t:t,m:a},"*")}catch(e){}}' +
      '["log","error","warn","info"].forEach(function(k){var o=console[k]?console[k].bind(console):function(){};console[k]=function(){o.apply(null,arguments);s(k,Array.prototype.map.call(arguments,function(x){try{return typeof x==="object"?JSON.stringify(x):String(x)}catch(e){return String(x)}}).join(" "))}});' +
      'window.addEventListener("error",function(e){s("error",e.message+(e.lineno?" (строка "+e.lineno+")":""))});' +
      'window.addEventListener("unhandledrejection",function(e){s("error","Promise: "+(e.reason&&e.reason.message||e.reason))});})();<\/scr' + 'ipt>';
    const style = css ? '<style>\n' + css + '\n</style>' : '';
    const script = js ? '<scr' + 'ipt>\n' + js + '\n<\/scr' + 'ipt>' : '';
    if(/<html[\s>]/i.test(html)){
      // уже целый документ — дописываем стиль в <head>, скрипт и захват консоли перед </body>
      let doc = html.replace(/<\/head>/i, style + '</head>');
      if(!/<\/head>/i.test(html)) doc = style + doc;
      doc = doc.replace(/<\/body>/i, cap + script + '</body>');
      if(!/<\/body>/i.test(html)) doc = doc + cap + script;
      return doc;
    }
    return '<!doctype html><html><head><meta charset="utf-8">' + style + '</head><body>' + cap + html + script + '</body></html>';
  }

  let t = null;
  function renderPreview(){
    frame.srcdoc = buildDoc();
  }
  function schedulePreview(){ if(!live) return; clearTimeout(t); t = setTimeout(renderPreview, 350); }

  window.addEventListener('message', e => {
    const d = e.data; if(!d || !d.__sb) return;
    const mark = d.t === 'error' ? '🔴' : d.t === 'warn' ? '🟡' : '·';
    conEl.textContent += mark + ' ' + d.m + '\n';
    conEl.scrollTop = conEl.scrollHeight;
  });

  // ── запуск одного файла на сервере (python и пр.) ──
  async function runServer(f){
    conEl.textContent += '▶ ' + f.name + ' (' + langName(f.lang) + ')…\n';
    conEl.scrollTop = conEl.scrollHeight;
    let r;
    try { r = await fetch('/api/run', { method:'POST', body: JSON.stringify({ lang: f.lang, code: f.code }) }).then(x => x.json()); }
    catch(_){ r = { ok:false, error:'сервер недоступен — запусти node tools/code-lab-server.mjs' }; }
    if(!r.ok){ conEl.textContent += '🔴 ' + (r.error || 'ошибка') + '\n'; }
    else {
      if(r.stdout) conEl.textContent += r.stdout + (r.stdout.endsWith('\n') ? '' : '\n');
      if(r.stderr) conEl.textContent += '🟡 ' + r.stderr + (r.stderr.endsWith('\n') ? '' : '\n');
      if(r.timedOut) conEl.textContent += '🔴 превышено время (10с)\n';
      if(!r.stdout && !r.stderr) conEl.textContent += '(без вывода, код выхода ' + r.code + ')\n';
    }
    conEl.scrollTop = conEl.scrollHeight;
  }

  // ── разбор: клик по слову → пояснение ──
  // роль слова определяем по цвету, которым его раскрасил buildHighlight
  const COLOR_ROLE = { '#9090bb':'комментарий', '#52f2c9':'строка', '#ff8800':'число', '#b45cff':'ключевое слово', '#3dd9ff':'имя/вызов', '#cbc2ea':'имя', '#9c90c4':'знак' };
  function roleOf(sp){
    let c = sp.style.color || '';
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(c);
    if(m) c = '#' + [1,2,3].map(i => (+m[i]).toString(16).padStart(2,'0')).join('');
    return COLOR_ROLE[c.toLowerCase()] || 'имя';
  }
  // короткие пояснения по частым словам (JS + немного CSS/HTML)
  const EXPLAIN = {
    const:'const — объявляет имя, значение которого не будут переназначать. Читается как «постоянная».',
    let:'let — объявляет переменную, значение которой можно менять позже.',
    var:'var — старый способ объявить переменную. Сейчас предпочитают let/const.',
    function:'function — объявляет функцию: кусок кода, который можно вызывать по имени.',
    return:'return — функция отдаёт это значение обратно тому, кто её вызвал, и завершается.',
    if:'if — «если»: выполнить блок, только когда условие в скобках истинно.',
    else:'else — «иначе»: что делать, когда условие if не выполнилось.',
    for:'for — цикл: повторять блок заданное число раз.',
    while:'while — цикл: повторять блок, пока условие истинно.',
    async:'async — помечает функцию как асинхронную; внутри можно использовать await.',
    await:'await — ждёт результат промиса (например ответа из сети), не блокируя страницу.',
    new:'new — создаёт новый объект по «чертежу» (классу или конструктору).',
    class:'class — описывает «чертёж» объектов: их свойства и методы.',
    import:'import — подключает код из другого файла/модуля.',
    export:'export — открывает имя наружу, чтобы его можно было импортировать.',
    try:'try — пробуем выполнить код, который может дать ошибку.',
    catch:'catch — ловит ошибку из try и позволяет её обработать.',
    true:'true — логическая «истина» (да).', false:'false — логическая «ложь» (нет).',
    null:'null — «пусто намеренно»: значения нет.', undefined:'undefined — значение не задано.',
    this:'this — ссылка на текущий объект/контекст, в котором выполняется код.',
    console:'console — встроенный объект для вывода в консоль (отладки).',
    log:'log — печатает значение в консоль. console.log(x) — показать x.',
    document:'document — вся загруженная страница; через него находят и меняют элементы.',
    queryselector:'querySelector — находит на странице первый элемент по CSS-селектору.',
    queryselectorall:'querySelectorAll — находит все элементы по селектору (список).',
    getelementbyid:'getElementById — находит элемент по его id.',
    addeventlistener:'addEventListener — вешает обработчик на событие (клик, ввод и т.д.).',
    textcontent:'textContent — текст внутри элемента; можно прочитать или заменить.',
    innerhtml:'innerHTML — HTML-содержимое элемента; осторожно с чужими данными.',
    fetch:'fetch — делает запрос в сеть и возвращает промис с ответом.',
    json:'json() — разбирает ответ сети в объект JavaScript.',
    then:'then — что сделать, когда промис выполнится (получит результат).',
    catch2:'catch — обработать ошибку промиса.',
    map:'map — проходит по массиву и возвращает новый массив из результатов.',
    filter:'filter — оставляет из массива только элементы, подходящие под условие.',
    foreach:'forEach — выполняет действие для каждого элемента массива.',
    push:'push — добавляет элемент в конец массива.',
    length:'length — длина: сколько элементов в массиве или символов в строке.',
    settimeout:'setTimeout — выполнить код один раз через заданную задержку.',
    // CSS
    color:'color (CSS) — цвет текста элемента.',
    background:'background (CSS) — фон элемента: цвет, картинка.',
    'background-color':'background-color (CSS) — цвет фона.',
    margin:'margin (CSS) — внешний отступ, расстояние снаружи элемента.',
    padding:'padding (CSS) — внутренний отступ, расстояние внутри, от края до содержимого.',
    display:'display (CSS) — как элемент раскладывается: block, flex, grid, none…',
    flex:'flex (CSS) — гибкая раскладка: дети выстраиваются в ряд/колонку.',
    height:'height (CSS) — высота элемента. 100vh — на всю высоту экрана.',
    width:'width (CSS) — ширина элемента.',
    'font-size':'font-size (CSS) — размер шрифта.',
    'border-radius':'border-radius (CSS) — скругление углов.'
  };
  let pop = null;
  function hidePop(){ if(pop){ pop.remove(); pop = null; } }
  function showPop(title, role, body, ev){
    hidePop();
    pop = document.createElement('div'); pop.className = 'sb-pop';
    pop.innerHTML = '<div class="sb-pop-h"><b>' + title.replace(/[<>&]/g, '') + '</b> <span class="sb-pop-r">' + role + '</span></div><div class="sb-pop-b"></div>';
    pop.querySelector('.sb-pop-b').textContent = body;
    document.body.appendChild(pop);
    const x = Math.min(ev.clientX, innerWidth - pop.offsetWidth - 12), y = Math.min(ev.clientY + 14, innerHeight - pop.offsetHeight - 12);
    pop.style.left = Math.max(8, x) + 'px'; pop.style.top = Math.max(8, y) + 'px';
  }
  document.addEventListener('mousedown', ev => { if(pop && !pop.contains(ev.target) && !(ev.target.closest && ev.target.closest('.sb-hl'))) hidePop(); });
  function explainToken(sp, ev){
    const word = sp.textContent.trim();
    if(!word || /^[\s{}()[\];,.<>/=+\-*%!?:&|@#'"`~^]+$/.test(word)) return;
    const role = roleOf(sp);
    let body = EXPLAIN[word] || EXPLAIN[word.toLowerCase()];
    if(!body){
      if(role === 'строка') body = 'Строка — текст в кавычках. Хранится как есть: буквы, символы, адрес и т.п.';
      else if(role === 'число') body = 'Число — значение для вычислений или размеров.';
      else if(role === 'комментарий') body = 'Комментарий — заметка для человека. Код её не выполняет.';
      else if(role === 'ключевое слово') body = 'Служебное слово языка — часть его грамматики.';
      else if(role === 'имя/вызов') body = '«' + word + '» — имя функции или встроенного объекта. Скобки после него значат вызов.';
      else body = '«' + word + '» — имя: так названа переменная, функция или свойство. Имя придумал автор кода; загляни, где оно задано.';
    }
    showPop(word, role, body, ev);
  }

  // ── рендер панелей-редакторов ──
  function renderEds(){
    edsEl.innerHTML = '';
    files.forEach(f => {
      const ed = document.createElement('div'); ed.className = 'sb-ed';
      const head = document.createElement('div'); head.className = 'sb-ed-head';

      const name = document.createElement('input'); name.className = 'sb-name'; name.value = f.name;
      name.oninput = () => { f.name = name.value; save(); };

      const sel = document.createElement('select'); sel.className = 'sb-lang';
      LANGS.forEach(l => { const o = document.createElement('option'); o.value = l.v; o.textContent = l.t; if(l.v === f.lang) o.selected = true; sel.appendChild(o); });
      sel.onchange = () => { f.lang = sel.value; save(); renderEds(); schedulePreview(); };

      head.appendChild(name); head.appendChild(sel);

      if(!isFront(f.lang)){
        const run1 = document.createElement('button'); run1.className = 'btn sb-run1'; run1.textContent = '▶'; run1.title = 'запустить этот файл на компьютере';
        run1.onclick = () => runServer(f);
        head.appendChild(run1);
      }

      const del = document.createElement('button'); del.className = 'sb-ed-del'; del.textContent = '🗑'; del.title = 'удалить файл';
      del.onclick = () => { files = files.filter(x => x !== f); if(!files.length) files = [{ id:uid(), name:'index.html', lang:'html', code:'' }]; save(); renderEds(); schedulePreview(); };
      head.appendChild(del);

      // редактор с цветной подсветкой: прозрачная textarea поверх раскрашенного pre
      const wrap = document.createElement('div'); wrap.className = 'sb-ed-wrap';
      const pre = document.createElement('pre'); pre.className = 'sb-hl'; pre.setAttribute('aria-hidden', 'true');
      const ta = document.createElement('textarea'); ta.className = 'sb-code'; ta.spellcheck = false; ta.wrap = 'off'; ta.value = f.code;
      const paint = () => { pre.innerHTML = ''; (window.buildHighlight ? window.buildHighlight(ta.value) : [document.createTextNode(ta.value)]).forEach(l => pre.appendChild(l)); };
      const syncScroll = () => { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; };
      ta.oninput = () => { f.code = ta.value; save(); paint(); schedulePreview(); };
      ta.addEventListener('scroll', syncScroll);
      // Tab вставляет отступ, а не прыгает по форме
      ta.onkeydown = ev => { if(ev.key === 'Tab'){ ev.preventDefault(); const s = ta.selectionStart, e2 = ta.selectionEnd; ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(e2); ta.selectionStart = ta.selectionEnd = s + 2; f.code = ta.value; save(); paint(); schedulePreview(); } };
      // клик по слову в режиме «разбор» — пояснение
      pre.addEventListener('click', ev => {
        if(!center.classList.contains('explain-on')) return;
        const sp = ev.target.closest('span'); if(!sp) return;
        explainToken(sp, ev);
      });
      paint();
      wrap.append(pre, ta);
      ed.appendChild(head); ed.appendChild(wrap); edsEl.appendChild(ed);
    });
  }

  // ── кнопки ──
  box.querySelector('#sbAdd').onclick = () => { files.push({ id:uid(), name:'файл' + (files.length + 1) + '.js', lang:'js', code:'' }); save(); renderEds(); schedulePreview(); };
  box.querySelector('#sbClr').onclick = () => { conEl.textContent = ''; };
  box.querySelector('#sbRun').onclick = () => {
    renderPreview();
    // плюс запускаем все не-frontend файлы на сервере
    files.filter(f => !isFront(f.lang)).forEach(runServer);
  };
  liveIn.onchange = () => { live = liveIn.checked; try { localStorage.setItem('codelab_sandbox_live', live ? '1' : '0'); } catch(_){} if(live) renderPreview(); };
  const exBtn = box.querySelector('#sbExplain');
  const setExplain = on => {
    center.classList.toggle('explain-on', on);
    exBtn.classList.toggle('ok', on);
    exBtn.textContent = on ? '🔍 разбор: вкл' : '🔍 разбор';
    exBtn.title = on ? 'клик по цветному слову в коде → пояснение. Нажми ещё раз, чтобы вернуться к правке.' : 'режим разбора: кликай по цветным словам в коде — объясню, что это';
    if(!on) hidePop();
    try { localStorage.setItem('codelab_sandbox_explain', on ? '1' : '0'); } catch(_){}
  };
  exBtn.onclick = () => setExplain(!center.classList.contains('explain-on'));
  let exInit = false; try { exInit = localStorage.getItem('codelab_sandbox_explain') === '1'; } catch(_){}
  setExplain(exInit);

  // ── перетягиваемая граница редактор | превью ──
  let EW = 50; try { EW = +localStorage.getItem('codelab_sandbox_ew') || 50; } catch(_){}
  const applyEW = () => box.style.setProperty('--sb-ew', EW + '%');
  applyEW();
  const gut = box.querySelector('#sbGut');
  gut.addEventListener('pointerdown', e => {
    e.preventDefault(); gut.classList.add('drag');
    const r = box.getBoundingClientRect();
    const mv = ev => { EW = Math.max(20, Math.min(80, (ev.clientX - r.left) / r.width * 100)); applyEW(); };
    const up = () => { gut.classList.remove('drag'); document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); try { localStorage.setItem('codelab_sandbox_ew', Math.round(EW)); } catch(_){} };
    document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
  });

  renderEds();

  // ── переключение режимов: визуал ↔ песочница ──
  const btn = document.getElementById('sandboxToggle');
  function setMode(sb){
    center.classList.toggle('sandbox-on', sb);
    box.style.display = sb ? 'flex' : 'none';
    if(btn){ btn.textContent = sb ? '🧩 к визуалу' : '🧪 песочница'; btn.title = sb ? 'вернуться к визуальному холсту со связями' : 'песочница: панели кода (HTML/CSS/JS и др.) + живой предпросмотр'; }
    try { localStorage.setItem('codelab_mode', sb ? 'sandbox' : 'visual'); } catch(_){}
    if(sb){ renderPreview(); }
  }
  if(btn) btn.onclick = () => setMode(!center.classList.contains('sandbox-on'));
  let initSb = false; try { initSb = localStorage.getItem('codelab_mode') === 'sandbox'; } catch(_){}
  if(initSb) setMode(true);
})();
