// Конструктор-холст: компоненты-узлы на 2D-поле, соединяются линиями
// (выход → вход). Слева палитра по категориям, справа инспектор
// (Настроить / Разобраться / Объяснить), снизу собранный код + запуск.
// Код собирается по связям: порядок = топологический обход рёбер.

// ── блоки-компоненты (каждый — самодостаточный кусок) ────────────────────────
const BLOCKS = {
  let:    { cat:'Переменные и данные', label:'переменная', type:'leaf', hint:'Коробка со значением. name — имя, value — что положить.', fields:[{k:'name',def:'цена'},{k:'value',def:'100'}], code:f=>`let ${f.name} = ${f.value};` },
  array:  { cat:'Переменные и данные', label:'массив', type:'leaf', hint:'Список значений через запятую.', fields:[{k:'name',def:'числа'},{k:'items',def:'40, 70, 30, 90, 55'}], code:f=>`const ${f.name} = [${f.items}];` },
  object: { cat:'Переменные и данные', label:'объект', type:'leaf', hint:'Карточка «ключ: значение».', fields:[{k:'name',def:'бумага'},{k:'body',def:'имя: "ОФЗ", купон: 7.1'}], code:f=>`const ${f.name} = { ${f.body} };` },
  map:    { cat:'Обработка', label:'map (преобразовать)', type:'leaf', hint:'Новый список: к каждому x применить выражение.', fields:[{k:'name',def:'удвоенные'},{k:'list',def:'числа'},{k:'expr',def:'x * 2'}], code:f=>`const ${f.name} = ${f.list}.map(x => ${f.expr});` },
  filter: { cat:'Обработка', label:'filter (отобрать)', type:'leaf', hint:'Оставить элементы, где условие истинно.', fields:[{k:'name',def:'большие'},{k:'list',def:'числа'},{k:'cond',def:'x > 50'}], code:f=>`const ${f.name} = ${f.list}.filter(x => ${f.cond});` },
  reduce: { cat:'Обработка', label:'reduce (свернуть)', type:'leaf', hint:'Свернуть список в одно значение. acc копит, x — текущий.', fields:[{k:'name',def:'сумма'},{k:'list',def:'числа'},{k:'expr',def:'acc + x'}], code:f=>`const ${f.name} = ${f.list}.reduce((acc, x) => ${f.expr}, 0);` },
  calc:   { cat:'Обработка', label:'расчёт (формула)', type:'leaf', hint:'Посчитать выражение и положить в имя.', fields:[{k:'name',def:'результат'},{k:'expr',def:'сумма / числа.length'}], code:f=>`const ${f.name} = ${f.expr};` },
  log:    { cat:'Вывод', label:'вывод в консоль', type:'leaf', hint:'Показать значение в превью при запуске.', fields:[{k:'value',def:'результат'}], code:f=>`console.log(${f.value});` },
  bars:   { cat:'Вывод', label:'столбики (canvas)', type:'draw', hint:'Нарисовать столбики по числам на холсте #c.', fields:[{k:'values',def:'40, 70, 30, 90, 55'}], code:f=>`const ctx = document.querySelector("#c").getContext("2d");\n[${f.values}].forEach((v, i) => { ctx.fillStyle = "#3DD9FF"; ctx.fillRect(i * 32, 140 - v, 22, v); });` },
  svg:    { cat:'Вывод', label:'SVG-линия', type:'draw', hint:'Линия по точкам «x,y x,y…» в области #out.', fields:[{k:'points',def:'0,90 20,70 40,80 60,40 80,55 100,20'}], code:f=>`document.querySelector("#out").innerHTML =\n  '<svg width="200" height="100"><polyline points="${f.points}" fill="none" stroke="#52F2C9" stroke-width="2"/></svg>';` },
  fetchj: { cat:'Сеть', label:'запрос (fetch)', type:'leaf', hint:'Сходить в сеть за JSON. Нужен await — ставь внутри async.', fields:[{k:'name',def:'данные'},{k:'url',def:'https://api.example.com/data'}], code:f=>`const ${f.name} = await fetch("${f.url}").then(r => r.json());` },
  iff:    { cat:'Логика', label:'если (if)', type:'leaf', hint:'Выполнить строку только если условие истинно.', fields:[{k:'cond',def:'цена > 50'},{k:'then',def:'console.log("дорого")'}], code:f=>`if (${f.cond}) { ${f.then}; }` },
  forN:   { cat:'Логика', label:'повторить N раз', type:'leaf', hint:'Повторить строку count раз (счётчик i).', fields:[{k:'count',def:'3'},{k:'body',def:'console.log(i)'}], code:f=>`for (let i = 0; i < ${f.count}; i++) { ${f.body}; }` },
  func:   { cat:'Логика', label:'функция', type:'leaf', hint:'Рецепт: вход args → тело. Многострочное тело пиши в body.', fields:[{k:'name',def:'посчитать'},{k:'args',def:'a, b'},{k:'body',def:'return a + b;'}], code:f=>`function ${f.name}(${f.args}) {\n  ${f.body}\n}` },
  raw:    { cat:'Своё', label:'свой код', type:'leaf', labelFn:f=>classify(f.code||''), hint:'Любой свой JS-код как есть — вставь или втяни из каталога.', fields:[{k:'code',multi:true,def:'// свой код\nconsole.log("привет");'}], code:f=>f.code },
};
function classify(text){
  const l = (text || '').trim().split('\n')[0] || '';
  if(/^(export\s+)?(async\s+)?function\b/.test(l)) return 'функция';
  if(/^(export\s+)?class\b/.test(l)) return 'класс';
  if(/^if\b/.test(l)) return 'условие';
  if(/^for\b/.test(l)) return 'цикл';
  if(/fetch\(/.test(l)) return 'запрос';
  if(/console\./.test(l)) return 'вывод';
  if(/^(export\s+)?(const|let|var)\b/.test(l)) return 'переменная';
  if(/\.(map|filter|reduce|forEach)\(/.test(l)) return 'обработка списка';
  return 'код';
}
const CATS = [...new Set(Object.values(BLOCKS).map(b => b.cat))];

// ── состояние: граф {nodes:[{id,blockId,fields,x,y,title?}], edges:[{from,to}]} ─
let graph = { nodes: [], edges: [] };
let selectedId = null, inspTab = 'set';
const LS = 'codelab_graph';
const uid = () => Math.random().toString(36).slice(2, 8);
const $ = s => document.querySelector(s);
const canvas = $('#canvas'), edgesSvg = $('#edges'), codeEl = $('#code'), preview = $('#preview');

function persist(){ try { localStorage.setItem(LS, JSON.stringify(graph)); } catch(_){} }
function restore(){
  try { const s = JSON.parse(localStorage.getItem(LS) || 'null');
    if(s && Array.isArray(s.nodes)) graph = { nodes: s.nodes, edges: Array.isArray(s.edges) ? s.edges : [] };
  } catch(_){}
}
const byId = id => graph.nodes.find(n => n.id === id);
function nodeLabel(nd){ const b = BLOCKS[nd.blockId]; return nd.title || (b.labelFn ? b.labelFn(nd.fields) : b.label); }
function nodeCode(nd){ const b = BLOCKS[nd.blockId]; const c = b.code(nd.fields); return b.type === 'container' ? (c.open + '\n' + c.close) : String(c); }
function nodePreview(nd){ const l = nodeCode(nd).split('\n')[0] || ''; return l.length > 36 ? l.slice(0, 36) + '…' : l; }
function kindClass(nd){ const b = BLOCKS[nd.blockId]; return b.type === 'draw' ? 'draw' : b.type === 'container' ? 'container' : 'leaf'; }

// ── таксономия как в каталоге: назначение → подкатегория ─────────────────────
const PURPOSE = [
  ['Интерфейс', ['dom','форм','ввод','кнопк','таблиц','карточк','модал','меню','уведомл','поиск','canvas','цвет','анимац','стил','css','верстк','grid','flex','клик','наведен','ползун','slider','рисов','отрисов','svg','экран','курсор','градиент','частиц']],
  ['Работа с данными', ['массив','объект','словар','строк','crud','база','sql','хранилищ','localstorage','кэш','миграц','импорт','экспорт','модел','схем','сохран','reduce','.map','filter','сортиров','фильтр','очеред','стек','дек','множеств']],
  ['Интеграции', ['fetch','api','http','rest','запрос','вебхук','webhook','почт','платеж','сторонн','таймаут','прокси','cors','moex','гир бо']],
  ['Файлы и документы', ['csv','xlsx','excel','pdf','docx','sheetjs','mammoth','разбор файл','чтение файл']],
  ['Автоматизация', ['расписан','планировщ','фонов','периодическ','cron','setinterval','пакет','батч','batch']],
  ['Диагностика и тестирование', ['тест','логир','ошибк','трассиров','монитор','debug','отладк','исключ','assert']],
  ['Запуск и инфраструктура', ['сервер','запуск','конфиг','зависимост','сборк','контейнер','env','порт','node','flask','маршрут','роут','модул','импорт','export']],
];
const PORDER = ['Интеграции','Файлы и документы','Автоматизация','Диагностика и тестирование','Запуск и инфраструктура','Интерфейс','Работа с данными'];
const SUBCATS = {
  'Интерфейс':[['Формы и ввод',['форм','input','ввод','checkbox','select','ползун','range','поле','type=']],['Таблицы и списки',['таблиц','tbody','список строк']],['Рисование (Canvas/SVG)',['canvas','svg','рисов','градиент','fillrect','filltext','arc','lineto','moveto','drawimage','кадр','частиц','clearrect','столбик']],['Цвета',['цвет','hsl','rgba','gradient','палитр']],['Анимация и время',['анимац','requestanimationframe','время']],['События',['событ','клик','keydown','keyup','клавиш','мыш','наведен','курсор']],['DOM-элементы',['dom','queryselector','createelement','classlist','setattribute','textcontent','innerhtml','style','append','надпис']]],
  'Работа с данными':[['Массивы и объекты',['массив','объект','map','reduce','filter','foreach']],['Строки',['строк','split','replace','join']],['Хранилище',['localstorage','хранилищ','кэш','setitem','сохран']],['База и CRUD',['crud','база','добав','найд','удал']],['Сортировка и фильтры',['сортиров','фильтр','sort']],['Структуры',['стек','очеред','дек','множеств','set']],['Основы',['переменн','услови','цикл','функц','тип','ветвлен','switch','break','continue','return']]],
  'Интеграции':[['HTTP-запросы',['fetch','http','запрос','анатом']],['Разбор ответа',['парсер','columns','разбор','ответ api']],['Прокси и CORS',['прокси','cors']],['Цепочки и параллельно',['цепочк','promise','await','параллель']]],
  'Файлы и документы':[['CSV',['csv']],['Excel',['xlsx','excel','sheetjs']],['Разбор',['парсер','разбор','parse']]],
  'Автоматизация':[['Таймеры',['таймер','интервал','setinterval']],['Планировщик',['расписан','планировщ','cron']],['Пакетная обработка',['пакет','батч','batch']]],
  'Диагностика и тестирование':[['Ошибки',['ошибк','try','catch','исключ']],['Логи',['лог','console']],['Тесты',['тест']],['Отладка',['отладк','debug','трассиров']]],
  'Запуск и инфраструктура':[['Серверы',['сервер','node','flask','порт']],['Маршруты',['маршрут','роут']],['Модули и импорты',['модул','импорт','export','файл']],['Конфигурация',['конфиг','env','сборк','зависимост']]],
};
function thay(t){ return ((t.group||'')+' '+(t.title||'')+' '+(t.desc||'')).toLowerCase(); }
function purposeOf(t){ if(t.comp && t.comp.tags && t.comp.tags.purpose && t.comp.tags.purpose.length) return t.comp.tags.purpose[0]; const h = thay(t); for(const key of PORDER){ const P = PURPOSE.find(x=>x[0]===key); if(P[1].some(w=>h.includes(w))) return key; } return 'Работа с данными'; }
function subOf(t, pk){ if(t.comp && t.comp.subcat) return t.comp.subcat; const defs = SUBCATS[pk]||[]; const h = thay(t); for(const [name,kws] of defs){ if(kws.some(w=>h.includes(w))) return name; } return 'Разное'; }

// ── палитра: Базовые блоки + компоненты каталога по иерархии назначений ───────
let CATALOG = [];
async function loadCatalog(){ try { CATALOG = await fetch('/api/list').then(r => r.json()); } catch(_){ CATALOG = []; } renderPalette(); }
function palDetails(title, count, open){
  const d = document.createElement('details'); d.className = 'pal-d'; if(open) d.open = true;
  const s = document.createElement('summary'); s.innerHTML = '<span>' + esc(title) + '</span><span class="pal-n">' + count + '</span>'; d.appendChild(s); return d;
}
function palItem(title, hint){ const it = el('div', 'pal-item2'); it.appendChild(el('span', 'pi-t', title)); if(hint) it.title = hint; return it; }
function renderPalette(){
  const host = $('#palList'); host.innerHTML = '';
  const q = ($('#palSearch').value || '').toLowerCase();
  // базовые блоки (со структурными полями)
  const base = Object.entries(BLOCKS).filter(([id, b]) => !q || (b.label + ' ' + (b.hint || '')).toLowerCase().includes(q));
  if(base.length){
    const d = palDetails('Базовые блоки', base.length, !!q || !CATALOG.length);
    base.forEach(([id, b]) => { const it = palItem(b.label, b.hint); it.onclick = () => addNode(id); d.appendChild(it); });
    host.appendChild(d);
  }
  // каталог по назначению → подкатегория
  const js = CATALOG.filter(t => (t.lang || 'js') === 'js').filter(t => !q || (t.title + ' ' + (t.desc || '')).toLowerCase().includes(q));
  const byP = {}; js.forEach(t => { const p = purposeOf(t); (byP[p] = byP[p] || []).push(t); });
  PURPOSE.map(x => x[0]).forEach(pk => {
    const items = byP[pk]; if(!items || !items.length) return;
    const d = palDetails(pk, items.length, !!q);
    const bySub = {}; items.forEach(t => { const s = subOf(t, pk); (bySub[s] = bySub[s] || []).push(t); });
    const order = (SUBCATS[pk] || []).map(x => x[0]).concat(['Разное']);
    Object.keys(bySub).sort((a, b) => { const ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); }).forEach(sub => {
      d.appendChild(el('div', 'pal-sub', sub + ' · ' + bySub[sub].length));
      bySub[sub].forEach(t => { const it = palItem(t.title, t.desc); it.onclick = () => addFromCatalog(t); d.appendChild(it); });
    });
    host.appendChild(d);
  });
}
async function addFromCatalog(t){
  try {
    const tpl = await fetch('/api/template?id=' + encodeURIComponent(t.id)).then(r => r.json());
    const code = (tpl.lines || []).map(line => (line || []).map(k => k.v != null ? k.v : '').join('')).join('\n');
    addNode('raw', { fields: { code }, title: t.title });
  } catch(_){}
}
$('#palSearch').oninput = renderPalette;

function makeNode(blockId, extra){
  const b = BLOCKS[blockId]; const fields = {}; (b.fields || []).forEach(f => fields[f.k] = f.def);
  return Object.assign({ id: uid(), blockId, fields, x: 80, y: 60 }, extra);
}
function spawnPos(){
  // каскад, чтобы новые не ложились друг на друга; с учётом прокрутки
  const sc = $('.canvas-scroll');
  const n = graph.nodes.length;
  return { x: (sc ? sc.scrollLeft : 0) + 40 + (n % 6) * 30, y: (sc ? sc.scrollTop : 0) + 40 + (n % 6) * 30 };
}
function addNode(blockId, extra){
  const p = spawnPos();
  const nd = makeNode(blockId, Object.assign({ x: p.x, y: p.y }, extra || {}));
  graph.nodes.push(nd); renderCanvas(); select(nd); persist(); renderCode();
  return nd;
}

// ── холст ─────────────────────────────────────────────────────────────────────
function renderCanvas(){
  canvas.querySelectorAll('.gnode').forEach(el => el.remove());
  graph.nodes.forEach(nd => canvas.appendChild(nodeEl(nd)));
  $('#emptyHint').style.display = graph.nodes.length ? 'none' : 'block';
  drawEdges();
}
function nodeEl(nd){
  const el = document.createElement('div');
  el.className = 'gnode ' + kindClass(nd) + (nd.id === selectedId ? ' sel' : '');
  el.dataset.id = nd.id; el.style.left = nd.x + 'px'; el.style.top = nd.y + 'px';
  const pin = document.createElement('div'); pin.className = 'port in'; pin.dataset.id = nd.id;
  const pout = document.createElement('div'); pout.className = 'port out'; pout.dataset.id = nd.id;
  const head = document.createElement('div'); head.className = 'gnode-head';
  const title = document.createElement('span'); title.className = 'gnode-title'; title.textContent = nodeLabel(nd);
  const del = document.createElement('button'); del.className = 'gnode-del'; del.textContent = '×'; del.title = 'удалить';
  del.onclick = e => { e.stopPropagation(); removeNode(nd.id); };
  head.append(title, del);
  const prev = document.createElement('div'); prev.className = 'gnode-prev'; prev.textContent = nodePreview(nd);
  el.append(pin, head, prev, pout);
  headDrag(head, el, nd);
  portConnect(pout, nd);
  return el;
}

// перетаскивание узла за шапку; без сдвига — это выбор
function headDrag(head, el, nd){
  head.addEventListener('pointerdown', e => {
    if(e.target.classList.contains('gnode-del')) return;
    e.preventDefault(); head.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY, ox = nd.x, oy = nd.y; let moved = false;
    const mv = ev => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if(!moved && Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if(moved){ nd.x = Math.max(0, ox + dx); nd.y = Math.max(0, oy + dy); el.style.left = nd.x + 'px'; el.style.top = nd.y + 'px'; drawEdges(); }
    };
    const up = ev => {
      head.releasePointerCapture(e.pointerId);
      head.removeEventListener('pointermove', mv); head.removeEventListener('pointerup', up);
      if(moved) persist(); else select(nd);
    };
    head.addEventListener('pointermove', mv); head.addEventListener('pointerup', up);
  });
}

// протянуть связь от выхода к входу другого узла
let connecting = null;
function portConnect(pout, nd){
  pout.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    connecting = { from: nd.id };
    const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'path'); tmp.setAttribute('class', 'tmp'); edgesSvg.appendChild(tmp);
    const cr = () => canvas.getBoundingClientRect();
    const start = portXY(nd.id, 'out');
    const mv = ev => {
      const r = cr(); const x2 = ev.clientX - r.left, y2 = ev.clientY - r.top;
      tmp.setAttribute('d', bez(start.x, start.y, x2, y2));
      const hot = document.elementFromPoint(ev.clientX, ev.clientY);
      document.querySelectorAll('.port.in.hot').forEach(p => p.classList.remove('hot'));
      if(hot && hot.classList.contains('in')) hot.classList.add('hot');
    };
    const up = ev => {
      document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
      tmp.remove(); document.querySelectorAll('.port.in.hot').forEach(p => p.classList.remove('hot'));
      const t = document.elementFromPoint(ev.clientX, ev.clientY);
      if(t && t.classList.contains('in') && t.dataset.id && t.dataset.id !== nd.id) addEdge(nd.id, t.dataset.id);
      connecting = null;
    };
    document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
  });
}
function addEdge(from, to){
  if(graph.edges.some(e => e.from === from && e.to === to)) return;
  graph.edges.push({ from, to }); drawEdges(); persist(); renderCode();
}
function removeNode(id){
  graph.nodes = graph.nodes.filter(n => n.id !== id);
  graph.edges = graph.edges.filter(e => e.from !== id && e.to !== id);
  if(selectedId === id){ selectedId = null; renderInspector(); }
  renderCanvas(); persist(); renderCode();
}

// координаты порта узла (в системе холста) по его DOM-элементу
function portXY(id, which){
  const el = canvas.querySelector('.gnode[data-id="' + cssEsc(id) + '"]'); if(!el) return { x: 0, y: 0 };
  const x = el.offsetLeft + el.offsetWidth / 2;
  const y = which === 'out' ? el.offsetTop + el.offsetHeight : el.offsetTop;
  return { x, y };
}
function bez(x1, y1, x2, y2){ const dy = Math.max(30, Math.abs(y2 - y1) / 2); return 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + dy) + ' ' + x2 + ' ' + (y2 - dy) + ' ' + x2 + ' ' + y2; }
function drawEdges(){
  edgesSvg.querySelectorAll('path:not(.tmp)').forEach(p => p.remove());
  graph.edges.forEach(e => {
    if(!byId(e.from) || !byId(e.to)) return;
    const a = portXY(e.from, 'out'), b = portXY(e.to, 'in');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', bez(a.x, a.y, b.x, b.y)); edgesSvg.appendChild(p);
  });
}
canvas.addEventListener('pointerdown', e => { if(e.target === canvas || e.target === edgesSvg){ selectedId = null; markSel(); renderInspector(); } });
// Delete/Backspace — удалить выделенный узел (если не печатаем в поле)
document.addEventListener('keydown', e => {
  if(e.key !== 'Delete' && e.key !== 'Backspace') return;
  if(!selectedId) return;
  const ae = document.activeElement; if(ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return;
  e.preventDefault(); removeNode(selectedId);
});

// ── инспектор ─────────────────────────────────────────────────────────────────
function select(nd){ selectedId = nd.id; markSel(); renderInspector(nd); persist(); }
function markSel(){ canvas.querySelectorAll('.gnode').forEach(el => el.classList.toggle('sel', el.dataset.id === selectedId)); }
function updateCard(nd){
  const el = canvas.querySelector('.gnode[data-id="' + cssEsc(nd.id) + '"]'); if(!el) return;
  el.querySelector('.gnode-title').textContent = nodeLabel(nd);
  el.querySelector('.gnode-prev').textContent = nodePreview(nd);
  drawEdges();
}
function renderInspector(nd){
  const host = $('#inspector'); if(!host) return;
  nd = nd || (selectedId ? byId(selectedId) : null);
  if(!nd){ host.innerHTML = '<div class="insp-body"><div class="insp-empty">Выбери узел на холсте — здесь его поля (Настроить), подсказка (Разобраться) и объяснение с кодом (Объяснить).<br><br>Пусто? Слева выбери компонент.</div></div>'; return; }
  const b = BLOCKS[nd.blockId];
  host.innerHTML = '';
  const head = document.createElement('div'); head.className = 'insp-head';
  [['set','Настроить'],['learn','Разобраться'],['why','Объяснить']].forEach(([k, lbl]) => {
    const btn = document.createElement('button'); btn.textContent = lbl; if(k === inspTab) btn.classList.add('on');
    btn.onclick = () => { inspTab = k; renderInspector(nd); };
    head.appendChild(btn);
  });
  host.appendChild(head);
  const body = document.createElement('div'); body.className = 'insp-body';
  const titleEl = el('div', 'insp-title', nodeLabel(nd)); body.appendChild(titleEl);
  body.appendChild(el('div', 'insp-kind', b.type === 'draw' ? 'рисование' : 'компонент'));
  const save = el('button', 'insp-save', '💾 сохранить в каталог'); save.title = 'добавить этот кусок в каталог как компонент'; save.onclick = () => saveToCatalog(nd); body.appendChild(save);
  if(inspTab === 'set'){ body.appendChild(nodeMetaEditor(nd, titleEl)); body.appendChild(inspFields(nd, b)); }
  else if(inspTab === 'learn') body.appendChild(el('div', 'insp-text', nd.desc || b.hint || 'описания нет. Открой «Настроить» → поле «описание», впиши своими словами.'));
  else body.appendChild(inspWhy(nd, b));
  host.appendChild(body);
}
function inspFields(nd, b){
  if(nd.blockId === 'raw') return rawInspFields(nd);   // у «своего кода» — поля по переменным + весь код
  if(!(b.fields || []).length) return el('div', 'insp-text', 'нет настроек.');
  const box = document.createElement('div');
  (b.fields || []).forEach(f => {
    const row = el('div', 'insp-field'); row.appendChild(el('label', '', f.k));
    if(f.multi){
      const ta = document.createElement('textarea'); ta.className = 'blk-code'; ta.spellcheck = false; ta.value = nd.fields[f.k];
      ta.rows = Math.min(16, String(nd.fields[f.k]).split('\n').length + 1);
      ta.addEventListener('input', () => { nd.fields[f.k] = ta.value; updateCard(nd); renderCode(); persist(); });
      row.appendChild(attachHighlight(ta));
    } else {
      const inp = document.createElement('input'); inp.value = nd.fields[f.k]; inp.spellcheck = false;
      inp.addEventListener('input', () => { nd.fields[f.k] = inp.value; updateCard(nd); renderCode(); persist(); });
      row.appendChild(inp);
    }
    box.appendChild(row);
  });
  return box;
}
// «Настроить» для своего кода: понятные поля по строкам `имя = значение;`
// (значения правятся прямо отсюда) + весь код в раскрывашке.
const VAR_RE = /^(\s*(?:const|let|var)\s+([A-Za-zА-Яа-яЁё_$][\wА-Яа-яЁё$]*)\s*=\s*)(.+);\s*$/;
function rawVars(code){ const out = []; String(code).split('\n').forEach((ln, i) => { const m = ln.match(VAR_RE); if(m) out.push({ i, name: m[2], value: m[3] }); }); return out; }
function setVar(nd, name, val){
  const lines = String(nd.fields.code || '').split('\n');
  for(let i = 0; i < lines.length; i++){ const m = lines[i].match(VAR_RE); if(m && m[2] === name){ lines[i] = m[1] + val + ';'; break; } }
  nd.fields.code = lines.join('\n');
}
function rawInspFields(nd){
  const box = document.createElement('div');
  const vars = rawVars(nd.fields.code);
  if(vars.length){
    const note = el('div', 'insp-kind', 'что можно поменять'); note.style.marginBottom = '6px'; box.appendChild(note);
    vars.forEach(v => {
      const row = el('div', 'insp-field'); row.appendChild(el('label', '', v.name));
      const inp = document.createElement('input'); inp.value = v.value; inp.spellcheck = false;
      inp.addEventListener('input', () => { setVar(nd, v.name, inp.value); updateCard(nd); renderCode(); persist(); });
      row.appendChild(inp); box.appendChild(row);
    });
  } else {
    box.appendChild(el('div', 'insp-text', 'Готовых полей тут нет — весь код ниже можно править целиком.'));
  }
  // весь код — в раскрывашке (или сразу, если полей нет)
  const det = document.createElement('details'); det.style.marginTop = '8px'; if(!vars.length) det.open = true;
  const sum = document.createElement('summary'); sum.textContent = 'весь код'; sum.style.cssText = 'cursor:pointer;color:var(--text3);font-size:12px;margin-bottom:6px'; det.appendChild(sum);
  const ta = document.createElement('textarea'); ta.className = 'blk-code'; ta.spellcheck = false; ta.value = nd.fields.code;
  ta.rows = Math.min(18, String(nd.fields.code).split('\n').length + 1);
  ta.addEventListener('input', () => { nd.fields.code = ta.value; updateCard(nd); renderCode(); persist(); });
  det.appendChild(attachHighlight(ta));
  box.appendChild(det);
  return box;
}

// редактор заголовка и описания узла (в «Настроить»)
function nodeMetaEditor(nd, titleEl){
  const box = document.createElement('div');
  const r1 = el('div', 'insp-field'); r1.appendChild(el('label', '', 'заголовок'));
  const ti = document.createElement('input'); ti.value = nodeLabel(nd); ti.spellcheck = false;
  ti.addEventListener('input', () => { nd.title = ti.value; updateCard(nd); if(titleEl) titleEl.textContent = ti.value; persist(); });
  r1.appendChild(ti); box.appendChild(r1);
  const r2 = el('div', 'insp-field'); r2.appendChild(el('label', '', 'описание (своими словами)'));
  const ta = document.createElement('textarea'); ta.className = 'insp-desc'; ta.spellcheck = false; ta.value = nd.desc || ''; ta.placeholder = 'что это и зачем — чтобы не забыть';
  ta.addEventListener('input', () => { nd.desc = ta.value; persist(); });
  r2.appendChild(ta); box.appendChild(r2);
  return box;
}
// сохранить узел как компонент в каталог (появится в каталоге и палитре)
function saveToCatalog(nd){
  const bg = el('div', 'modal-bg');
  const purposeOpts = PURPOSE.map(p => '<option>' + esc(p[0]) + '</option>').join('');
  bg.innerHTML = '<div class="modal"><h3>Сохранить в каталог</h3>'
    + '<p class="mh">Этот кусок станет компонентом в выбранном разделе — появится в каталоге и в палитре слева.</p>'
    + '<div class="mrow"><div class="mfield"><label>Назначение</label><select id="s-purpose">' + purposeOpts + '</select></div>'
    + '<div class="mfield"><label>Подкатегория</label><select id="s-sub"></select></div></div>'
    + '<div class="mfield"><label>Название</label><input id="s-title"></div>'
    + '<div class="mfield"><label>Описание</label><textarea id="s-desc" style="min-height:70px"></textarea></div>'
    + '<div class="mfield"><label>Код</label><textarea id="s-code" spellcheck="false"></textarea></div>'
    + '<div class="mbtns"><button class="btn ok" id="s-save">Сохранить</button><button class="btn" id="s-cancel">Отмена</button></div><div class="merr" id="s-err"></div></div>';
  document.body.appendChild(bg);
  const q = s => bg.querySelector(s);
  q('#s-title').value = nodeLabel(nd); q('#s-desc').value = nd.desc || ''; q('#s-code').value = nodeCode(nd);
  const fillSubs = () => { const pk = q('#s-purpose').value; const subs = (SUBCATS[pk] || []).map(x => x[0]).concat(['Разное']); q('#s-sub').innerHTML = subs.map(s => '<option>' + esc(s) + '</option>').join(''); };
  fillSubs(); q('#s-purpose').onchange = fillSubs;
  bg.onclick = e => { if(e.target === bg) bg.remove(); };
  q('#s-cancel').onclick = () => bg.remove();
  q('#s-save').onclick = async () => {
    const title = q('#s-title').value.trim(), code = q('#s-code').value;
    if(!title || !code.trim()){ q('#s-err').textContent = 'нужны название и код'; return; }
    const purpose = q('#s-purpose').value, subcat = q('#s-sub').value;
    const component = { type:'component', tags:{ purpose:[purpose], technology:['JavaScript'], runtime:[] }, subcat, summary:{ input:'', output:'', dependencies:[], requirements:[] } };
    const payload = { title, lang:'js', group: subcat, desc: q('#s-desc').value.trim(), code, component };
    q('#s-save').textContent = 'сохраняю…';
    const r = await fetch('/api/add', { method:'POST', body: JSON.stringify(payload) }).then(r => r.json()).catch(() => ({}));
    if(r.id){ bg.remove(); loadCatalog(); } else { q('#s-err').textContent = 'не сохранилось'; q('#s-save').textContent = 'Сохранить'; }
  };
}

function inspWhy(nd, b){
  const box = document.createElement('div');
  const first = (b.hint || '').split('.')[0];
  box.appendChild(el('div', 'insp-text', 'Это «' + nodeLabel(nd) + '». ' + (first ? first + '.' : '')));
  const cw = el('div', 'insp-code');
  const pre = document.createElement('pre'); pre.className = 'code mono'; pre.style.maxHeight = '240px';
  buildHighlight(nodeCode(nd)).forEach(l => pre.appendChild(l)); cw.appendChild(pre); box.appendChild(cw);
  return box;
}

// ── сборка кода по связям ─────────────────────────────────────────────────────
const byPos = (a, b) => (a.y - b.y) || (a.x - b.x);
function orderedNodes(){
  const incoming = {}; graph.nodes.forEach(n => incoming[n.id] = 0);
  graph.edges.forEach(e => { if(incoming[e.to] != null) incoming[e.to]++; });
  const adj = {}; graph.edges.forEach(e => { (adj[e.from] = adj[e.from] || []).push(e.to); });
  const seen = new Set(), order = [];
  const visit = id => { if(seen.has(id)) return; seen.add(id); const n = byId(id); if(n) order.push(n);
    (adj[id] || []).map(byId).filter(Boolean).sort(byPos).forEach(x => visit(x.id)); };
  graph.nodes.filter(n => !incoming[n.id]).sort(byPos).forEach(n => visit(n.id));
  graph.nodes.slice().sort(byPos).forEach(n => { if(!seen.has(n.id)){ seen.add(n.id); order.push(n); } });
  return order;
}
function currentCode(){
  const nodes = orderedNodes();
  const needAsync = nodes.some(n => /await /.test(nodeCode(n)));
  const body = nodes.map(nodeCode).join('\n');
  return needAsync ? '(async () => {\n' + body.split('\n').map(l => '  ' + l).join('\n') + '\n})();' : body;
}

// ── подсветка ─────────────────────────────────────────────────────────────────
const KW = new Set(['const','let','var','function','return','if','else','for','of','while','new','=>','await','async']);
const BI = new Set(['console','log','document','querySelector','getContext','addEventListener','map','reduce','filter','forEach','fillRect','innerHTML','fetch','then']);
function buildHighlight(code){
  const lines = [];
  String(code).split('\n').forEach(line => {
    const div = document.createElement('div'); div.className = 'line';
    let i = 0; const n = line.length;
    const push = (cls, v) => { const s = document.createElement('span'); if(cls) s.style.color = cls; s.textContent = v; div.appendChild(s); };
    while(i < n){
      const rest = line.slice(i), c = line[i];
      if(rest.startsWith('//')){ push('#9090BB', line.slice(i)); break; }
      if(c === '"' || c === "'" || c === '`'){ let j = i+1; while(j<n && line[j]!==c) j++; j++; push('#52F2C9', line.slice(i, j)); i = j; continue; }
      if(/[0-9]/.test(c)){ const mm=/^\d[\d.]*/.exec(rest); push('#FF8800', mm[0]); i+=mm[0].length; continue; }
      const im = /^[A-Za-zА-Яа-яЁё_$][\wА-Яа-яЁё$]*/.exec(rest);
      if(im){ const w=im[0]; let k=i+w.length; while(k<n&&line[k]===' ')k++;
        push(KW.has(w)?'#B45CFF':(line[k]==='('||BI.has(w))?'#3DD9FF':'#CBC2EA', w); i+=w.length; continue; }
      const ws2=/^\s+/.exec(rest); if(ws2){ push(null, ws2[0]); i+=ws2[0].length; continue; }
      push('#9C90C4', c); i++;
    }
    if(!line) div.appendChild(document.createTextNode('​'));
    lines.push(div);
  });
  return lines;
}
function renderCode(){ codeEl.innerHTML = ''; buildHighlight(currentCode()).forEach(l => codeEl.appendChild(l)); }
function attachHighlight(ta){
  const wrap = el('div', 'blk-code-wrap'); const pre = document.createElement('pre'); pre.className = 'blk-hl'; pre.setAttribute('aria-hidden', 'true');
  const sync = () => { pre.innerHTML = ''; buildHighlight(ta.value).forEach(l => pre.appendChild(l)); };
  ta.addEventListener('input', sync); ta.addEventListener('scroll', () => { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; });
  wrap.append(pre, ta); sync(); return wrap;
}

// ── запуск / файлы ────────────────────────────────────────────────────────────
function run(){
  const code = currentCode();
  preview.srcdoc = `<!doctype html><meta charset="utf-8"><body style="margin:8px;font:12px ui-monospace,monospace;color:#F6F4FF;background:#0E0720">
<canvas id="c" width="280" height="140" style="background:#140A24;border:1px solid #241638;border-radius:6px"></canvas>
<div id="out" style="margin-top:8px"></div>
<pre id="log" style="color:#52F2C9;white-space:pre-wrap;margin-top:8px"></pre>
<script>
var log=document.getElementById('log');
var _p=function(){ log.textContent += Array.prototype.join.call(arguments,' ')+'\\n'; };
var console={log:_p,error:_p,warn:_p,info:_p};
try{
${code}
}catch(e){ log.textContent += '\\u26d4 '+e.message; }
<\/script></body>`;
}
$('#copy').onclick = () => { navigator.clipboard.writeText(currentCode()); flash($('#copy'), '✓'); };
$('#run').onclick = run;
function download(name, text, mime){ const b = new Blob([text], { type: mime + ';charset=utf-8' }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 2000); }
function wrapHtml(code){ return '<!doctype html>\n<html lang="ru"><head><meta charset="utf-8"><title>моя страница</title>\n<style>body{margin:12px;font:13px ui-monospace,monospace;color:#F6F4FF;background:#0E0720}#log{color:#52F2C9;white-space:pre-wrap}</style></head>\n<body>\n<canvas id="c" width="300" height="160" style="background:#140A24;border:1px solid #241638;border-radius:6px"></canvas>\n<div id="out"></div><pre id="log"></pre>\n<script>\nvar log=document.getElementById("log");var _p=function(){log.textContent+=Array.prototype.join.call(arguments," ")+"\\n";};var console={log:_p,error:_p,warn:_p,info:_p};\ntry{\n' + code + '\n}catch(e){log.textContent+="\\u26d4 "+e.message;}\n<\/script>\n</body></html>\n'; }
$('#dl').onclick = () => { const code = currentCode(); const fmt = $('#fmt').value; if(fmt === 'html') download('схема.html', wrapHtml(code), 'text/html'); else if(fmt === 'txt') download('код.txt', code, 'text/plain'); else download('код.js', code, 'text/javascript'); flash($('#dl'), '✓'); };
function flash(b, t){ const o = b.textContent; b.textContent = t; setTimeout(() => b.textContent = o, 1000); }

$('#save').onclick = async () => {
  const code = currentCode(); if(!code.trim()){ flash($('#save'), 'пусто'); return; }
  const title = prompt('Название шаблона:', 'Моя сборка'); if(title === null) return;
  const r = await fetch('/api/add', { method: 'POST', body: JSON.stringify({ title: title || 'Моя сборка', lang: 'js', group: 'Из конструктора', code, desc: 'собрано в конструкторе' }) }).then(r => r.json()).catch(() => ({}));
  flash($('#save'), r.id ? '✓ в шаблонах' : 'ошибка');
};

// «+ компонент из каталога» — добавить узел «свой код» с кодом шаблона
$('#fromtpl').onclick = async e => {
  e.stopPropagation(); closeMenu();
  let list; try { list = await fetch('/api/list').then(r => r.json()); } catch(_){ return; }
  const jsOnly = list.filter(t => (t.lang || 'js') === 'js');
  const m = el('div', 'menu'); m.id = '_menu';
  const byGroup = {}; jsOnly.forEach(t => { (byGroup[t.group] = byGroup[t.group] || []).push(t); });
  if(!jsOnly.length) m.innerHTML = '<div class="mcat">нет JS-компонентов</div>';
  for(const g of Object.keys(byGroup)){
    m.appendChild(el('div', 'mcat', g));
    byGroup[g].forEach(t => {
      const it = el('div', 'mitem'); it.textContent = t.title;
      it.onclick = async () => { closeMenu();
        try { const tpl = await fetch('/api/template?id=' + encodeURIComponent(t.id)).then(r => r.json());
          const code = (tpl.lines || []).map(line => (line || []).map(k => k.v != null ? k.v : '').join('')).join('\n');
          addNode('raw', { fields: { code }, title: t.title });
        } catch(_){}
      };
      m.appendChild(it);
    });
  }
  document.body.appendChild(m);
  const r = $('#fromtpl').getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 320) + 'px'; m.style.top = (r.bottom + window.scrollY + 4) + 'px';
  setTimeout(() => document.addEventListener('mousedown', outside), 0);
};
function outside(e){ const m = $('#_menu'); if(m && !m.contains(e.target)) closeMenu(); }
function closeMenu(){ const m = $('#_menu'); if(m) m.remove(); document.removeEventListener('mousedown', outside); }

// разобрать HTML на части: разметка / стили / скрипт(ы)
function breakdownHTML(text){
  const parts = [];
  const scripts = [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1].trim()).filter(Boolean);
  const styles  = [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1].trim()).filter(Boolean);
  const markup  = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
  if(markup) parts.push({ title: 'разметка (HTML)', code: markup });
  styles.forEach((s, i) => parts.push({ title: 'стили (CSS)' + (styles.length > 1 ? ' ' + (i + 1) : ''), code: s }));
  scripts.forEach((s, i) => parts.push({ title: 'скрипт (JS)' + (scripts.length > 1 ? ' ' + (i + 1) : ''), code: s }));
  return parts.length ? parts : [{ title: 'HTML', code: text }];
}
// разбить JS на верхнеуровневые шаги (функции/объявления/вызовы)
function splitTopLevel(code){
  const out = []; let brace = 0, paren = 0, seg = '', i = 0; const n = code.length;
  const push = () => { const t = seg.trim(); if(t) out.push(t); seg = ''; };
  const skipStr = (j, q) => { j++; while(j < n){ if(code[j] === '\\'){ j += 2; continue; } if(code[j] === q){ j++; break; } j++; } return j; };
  while(i < n){
    const c = code[i];
    if(c === '"' || c === "'" || c === '`'){ const j = skipStr(i, c); seg += code.slice(i, j); i = j; continue; }
    if(c === '/' && code[i + 1] === '/'){ let j = code.indexOf('\n', i); if(j < 0) j = n; seg += code.slice(i, j); i = j; continue; }
    if(c === '/' && code[i + 1] === '*'){ let j = code.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; seg += code.slice(i, j); i = j; continue; }
    if(c === '(' || c === '['){ paren++; seg += c; i++; continue; }
    if(c === ')' || c === ']'){ paren = Math.max(0, paren - 1); seg += c; i++; continue; }
    if(c === '{'){ brace++; seg += c; i++; continue; }
    if(c === '}'){ brace = Math.max(0, brace - 1); seg += c; i++;
      if(brace === 0 && paren === 0){ let j = i; while(j < n && /\s/.test(code[j])) j++; if(code[j] === ';'){ seg += code.slice(i, j + 1); i = j + 1; } push(); }
      continue; }
    if(c === ';' && brace === 0 && paren === 0){ seg += c; push(); i++; continue; }
    seg += c; i++;
  }
  push();
  return out.filter(Boolean);
}
// положить части колонкой и соединить стрелками (выход → вход)
function addPieces(parts){
  const startX = graph.nodes.length ? Math.max(...graph.nodes.map(n => n.x)) + 240 : 60;
  let prev = null;
  parts.forEach((pc, i) => {
    const nd = makeNode('raw', { fields: { code: pc.code }, title: pc.title, x: startX, y: 50 + i * 150 });
    graph.nodes.push(nd);
    if(prev) graph.edges.push({ from: prev.id, to: nd.id });
    prev = nd;
  });
  renderCanvas(); renderCode(); persist();
  if(parts.length) select(graph.nodes[graph.nodes.length - 1]);
}
$('#imp').onclick = () => $('#impfile').click();
$('#impfile').onchange = async e => {
  const f = e.target.files && e.target.files[0]; if(!f) return;
  const text = await f.text(); if(text.length > 120000){ alert('Файл большой — возьми кусок поменьше.'); return; }
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  let parts;
  if(ext === 'html' || ext === 'htm') parts = breakdownHTML(text);
  else if(['js','mjs','jsx','ts'].includes(ext)) parts = splitTopLevel(text).map(c => ({ title: classify(c), code: c }));
  else parts = [{ title: f.name.replace(/\.[^.]+$/, ''), code: text }];
  addPieces(parts);
  e.target.value = '';
};

$('#clear').onclick = () => { graph = { nodes: [], edges: [] }; selectedId = null; renderCanvas(); renderInspector(); renderCode(); persist(); };
$('#example').onclick = () => {
  const a = uid(), b = uid(), c = uid(), d = uid();
  graph = { nodes: [
    { id:a, blockId:'array',  fields:{ name:'числа', items:'40, 70, 30, 90, 55' }, x:70,  y:60 },
    { id:b, blockId:'reduce', fields:{ name:'сумма', list:'числа', expr:'acc + x' }, x:70,  y:230 },
    { id:c, blockId:'calc',   fields:{ name:'среднее', expr:'сумма / числа.length' }, x:70, y:400 },
    { id:d, blockId:'bars',   fields:{ values:'40, 70, 30, 90, 55' }, x:360, y:230 },
  ], edges: [ { from:a, to:b }, { from:b, to:c }, { from:a, to:d } ] };
  selectedId = null; renderCanvas(); renderInspector(); renderCode(); persist();
};

function el(tag, cls, text){ const e = document.createElement(tag); if(cls) e.className = cls; if(text != null) e.textContent = text; return e; }
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
function cssEsc(s){ return String(s).replace(/["\\]/g, '\\$&'); }

restore();
loadCatalog();
renderCanvas();
renderInspector();
renderCode();
