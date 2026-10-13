// Конструктор кода: дерево блоков → настоящий JS. Контейнеры (if/for/функция/
// клик) дают вложенный слот и видимые скобки { }. Справа — собранный код
// (с подсветкой) и запуск в песочнице-iframe (есть canvas #c и #out для рисунков).

// ── определения блоков ──────────────────────────────────────────────────────
// leaf.code(f) → строка (может быть многострочной)
// container.code(f) → { open, close }  (между ними кладётся вложенный код)
const BLOCKS = {
  let:    { cat:'Основы', label:'переменная', type:'leaf', hint:'Коробка со значением. name — как назовёшь, value — что положишь. Потом к значению обращаешься по имени.', fields:[{k:'name',def:'цена'},{k:'value',def:'100'}], code:f=>`let ${f.name} = ${f.value};` },
  log:    { cat:'Основы', label:'вывод в консоль', type:'leaf', hint:'Показать значение в превью (при запуске). В value — что напечатать: имя переменной или текст в кавычках.', fields:[{k:'value',def:'цена'}], code:f=>`console.log(${f.value});` },
  comment:{ cat:'Основы', label:'комментарий', type:'leaf', hint:'Заметка для человека. Код её не выполняет — просто пояснение рядом.', fields:[{k:'text',def:'пояснение'}], code:f=>`// ${f.text}` },
  array:  { cat:'Данные', label:'массив', type:'leaf', hint:'Список значений через запятую. name — имя списка, items — что внутри. Доступ по номеру (с 0).', fields:[{k:'name',def:'числа'},{k:'items',def:'1, 2, 3, 4'}], code:f=>`const ${f.name} = [${f.items}];` },
  object: { cat:'Данные', label:'объект', type:'leaf', hint:'Карточка «ключ: значение». В body — поля через запятую (имя: "ОФЗ", купон: 7.1).', fields:[{k:'name',def:'бумага'},{k:'body',def:'имя: "ОФЗ", купон: 7.1'}], code:f=>`const ${f.name} = { ${f.body} };` },
  map:    { cat:'Данные', label:'map (преобразовать)', type:'leaf', hint:'Сделать НОВЫЙ список: к каждому элементу x применить выражение. Нужен готовый список (блок «массив») в list.', fields:[{k:'name',def:'удвоенные'},{k:'list',def:'числа'},{k:'expr',def:'x * 2'}], code:f=>`const ${f.name} = ${f.list}.map(x => ${f.expr});` },
  reduce: { cat:'Данные', label:'reduce (свернуть)', type:'leaf', hint:'Свернуть список в ОДНО число. acc копит результат, x — текущий элемент. Нужен список в list.', fields:[{k:'name',def:'сумма'},{k:'list',def:'числа'},{k:'expr',def:'acc + x'}], code:f=>`const ${f.name} = ${f.list}.reduce((acc, x) => ${f.expr}, 0);` },
  iff:    { cat:'Управление', label:'если (if)', type:'container', hint:'Выполнить вложенное ТОЛЬКО если условие истинно. Клади блоки ВНУТРЬ (по его «+ блок»).', fields:[{k:'cond',def:'цена > 50'}], code:f=>({ open:`if (${f.cond}) {`, close:'}' }) },
  forN:   { cat:'Управление', label:'цикл N раз', type:'container', hint:'Повторить вложенное count раз. Внутри доступен счётчик i (0,1,2…). Клади блоки ВНУТРЬ.', fields:[{k:'count',def:'3'}], code:f=>({ open:`for (let i = 0; i < ${f.count}; i++) {`, close:'}' }) },
  forOf:  { cat:'Управление', label:'перебор массива', type:'container', hint:'Пройти по каждому элементу списка; item — текущий. Нужен список в list. Клади блоки ВНУТРЬ.', fields:[{k:'item',def:'x'},{k:'list',def:'числа'}], code:f=>({ open:`for (const ${f.item} of ${f.list}) {`, close:'}' }) },
  func:   { cat:'Функции', label:'функция', type:'container', hint:'Рецепт. Приними входы (args), ВНУТРЬ положи шаги и блок «вернуть». Сама не запускается — её надо ВЫЗВАТЬ (блок «вызвать функцию» ниже).', fields:[{k:'name',def:'посчитать'},{k:'args',def:'a, b'}], code:f=>({ open:`function ${f.name}(${f.args}) {`, close:'}' }) },
  ret:    { cat:'Функции', label:'вернуть (return)', type:'leaf', hint:'Отдать результат из функции наружу. Ставь ВНУТРИ блока «функция». В value — что вернуть.', fields:[{k:'value',def:'a + b'}], code:f=>`return ${f.value};` },
  call:   { cat:'Функции', label:'вызвать функцию', type:'leaf', hint:'Запустить функцию по имени с конкретными значениями (args) и показать результат. name должен совпадать с именем функции.', fields:[{k:'name',def:'посчитать'},{k:'args',def:'4, 5'}], code:f=>`console.log(${f.name}(${f.args}));` },
  svg:    { cat:'Отрисовка', label:'SVG-линия', type:'draw', hint:'Нарисовать линию по точкам «x,y x,y…» в области #out. Больше точек — длиннее кривая.', fields:[{k:'points',def:'0,90 20,70 40,80 60,40 80,55 100,20'}], code:f=>`document.querySelector("#out").innerHTML =\n  '<svg width="200" height="100"><polyline points="${f.points}" fill="none" stroke="#52F2C9" stroke-width="2"/></svg>';` },
  bars:   { cat:'Отрисовка', label:'столбики (canvas)', type:'draw', hint:'Нарисовать столбики по числам (values) на холсте #c. Каждое число — высота столбика.', fields:[{k:'values',def:'40, 70, 30, 90, 55'}], code:f=>`const ctx = document.querySelector("#c").getContext("2d");\n[${f.values}].forEach((v, i) => { ctx.fillStyle = "#3DD9FF"; ctx.fillRect(i * 32, 140 - v, 22, v); });` },
  click:  { cat:'Интерактив', label:'по клику', type:'container', hint:'Выполнять вложенное при КЛИКЕ по элементу. sel — что кликаем (#c — холст). Клади блоки ВНУТРЬ.', fields:[{k:'sel',def:'#c'}], code:f=>({ open:`document.querySelector("${f.sel}").addEventListener("click", () => {`, close:'});' }) },
  raw:    { cat:'Своё', label:'свой код', type:'leaf', labelFn:f=>classify(f.code||''), hint:'Любой свой/вставленный JS-код как есть. Так можно втянуть в конструктор код из шаблона или откуда угодно и комбинировать с блоками.', fields:[{k:'code',multi:true,def:'// вставь сюда свой код\nconsole.log("привет");'}], code:f=>f.code },
  block:  { cat:'Своё', type:'container', label:'блок { }',
            labelFn:f=>classify(f.header||''),
            hintFn:f=>'заголовок: ' + ((f.header||'').trim() || '(пусто)') + ' — дальше вложенные блоки. Меняй заголовок/вложенное, добавляй и удаляй.',
            fields:[{k:'header',def:'if (x > 0)'},{k:'tail',def:''}],
            code:f=>({ open:(f.header && f.header.trim() ? f.header.trim() + ' {' : '{'), close:'}' + (f.tail ? f.tail : '') }) },
};

// грубая классификация строки кода → подпись «что это» (для импортированного)
function classify(text){
  const l = (text || '').trim().split('\n')[0] || '';
  if(/^(export\s+)?(async\s+)?function\b/.test(l)) return 'функция';
  if(/\b(const|let|var)\b.*=>\s*\(?$|\b(const|let|var)\b.*=>\s*$/.test(l)) return 'функция (стрелка)';
  if(/^(export\s+)?class\b/.test(l)) return 'класс';
  if(/^else\s+if\b/.test(l)) return 'иначе если';
  if(/^}?\s*else\b/.test(l)) return 'иначе';
  if(/^if\b/.test(l)) return 'условие if';
  if(/^for\b/.test(l)) return 'цикл for';
  if(/^while\b/.test(l)) return 'цикл while';
  if(/^switch\b/.test(l)) return 'switch';
  if(/^try\b/.test(l)) return 'try';
  if(/^}?\s*catch\b/.test(l)) return 'catch';
  if(/addEventListener/.test(l)) return 'обработчик события';
  if(/^return\b/.test(l)) return 'возврат';
  if(/console\.(log|error|warn|info)/.test(l)) return 'вывод';
  if(/^(import|export)\b/.test(l)) return 'импорт/экспорт';
  if(/^(export\s+)?(const|let|var)\b/.test(l)) return 'переменная';
  if(/^[\w.$\[\]]+\s*[-+*/]?=/.test(l)) return 'присваивание';
  if(/^[\w.$]+\s*\(|\.\w+\(/.test(l)) return 'вызов';
  if(/^\/\//.test(l)) return 'комментарий';
  if(/^[\w"']+\s*:/.test(l) && !/[;{}]/.test(l)) return 'поле объекта';
  return 'код';
}
const CATS = [...new Set(Object.values(BLOCKS).map(b => b.cat))];

// ── состояние: «файлы»-вкладки, у каждой своё дерево узлов ────────────────────
// root всегда указывает на дерево активной вкладки. Всё сохраняется в
// localStorage, чтобы большая программа не терялась при перезагрузке.
let files = [{ name: 'файл 1', root: { children: [] } }];
let active = 0;
let root = files[active].root;
const LS = 'codelab_ctor_files';
function setRoot(r){ root = r; files[active].root = r; }
function persist(){ try { localStorage.setItem(LS, JSON.stringify({ files, active })); } catch(_){} }
function restore(){
  try {
    const s = JSON.parse(localStorage.getItem(LS) || 'null');
    if(s && Array.isArray(s.files) && s.files.length){
      files = s.files.map(f => ({ name: String(f.name || 'файл'), root: (f.root && f.root.children) ? f.root : { children: [] } }));
      active = Math.min(Math.max(0, s.active | 0), files.length - 1);
      root = files[active].root;
    }
  } catch(_){}
}
function switchTab(i){ if(i < 0 || i >= files.length) return; active = i; root = files[active].root; renderTree(); }
const uid = () => Math.random().toString(36).slice(2, 8);
function makeNode(id){
  const b = BLOCKS[id]; const fields = {}; (b.fields || []).forEach(f => fields[f.k] = f.def);
  const nd = { uid: uid(), blockId: id, fields };
  if(b.type === 'container') nd.children = [];
  return nd;
}

const $ = s => document.querySelector(s);
const ws = $('#ws'), codeEl = $('#code'), preview = $('#preview');
let selectedUid = null;   // какой узел выбран (его правит инспектор справа)
let inspTab = 'set';      // вкладка инспектора: set | learn | why

// ── вкладки-«файлы» ───────────────────────────────────────────────────────────
function renderTabs(){
  const bar = $('#tabs'); if(!bar) return;
  bar.innerHTML = '';
  files.forEach((f, i) => {
    const t = document.createElement('div'); t.className = 'ftab' + (i === active ? ' on' : '');
    const nm = document.createElement('span'); nm.textContent = f.name;
    nm.onclick = () => switchTab(i);
    nm.ondblclick = () => { const v = prompt('Имя файла:', f.name); if(v){ f.name = v.slice(0, 40); renderTree(); } };
    t.appendChild(nm);
    if(files.length > 1){
      const x = document.createElement('span'); x.className = 'fx'; x.textContent = '×'; x.title = 'удалить вкладку';
      x.onclick = e => {
        e.stopPropagation();
        if(!confirm('Удалить вкладку «' + f.name + '» со всем её содержимым?')) return;
        files.splice(i, 1); if(active >= files.length) active = files.length - 1;
        root = files[active].root; renderTree();
      };
      t.appendChild(x);
    }
    bar.appendChild(t);
  });
  const add = document.createElement('button'); add.className = 'faddf'; add.textContent = '+ файл'; add.title = 'новая вкладка (двойной клик по имени — переименовать)';
  add.onclick = () => { files.push({ name: 'файл ' + (files.length + 1), root: { children: [] } }); active = files.length - 1; root = files[active].root; renderTree(); };
  bar.appendChild(add);
}

// ── рендер графа узлов ────────────────────────────────────────────────────────
function renderGraph(){ ws.innerHTML = ''; ws.appendChild(renderChildren(root.children, root)); }
function renderTree(){ renderTabs(); renderGraph(); renderCode(); renderInspector(); persist(); }

function renderChildren(arr, parent){
  const frag = document.createDocumentFragment();
  arr.forEach((nd, i) => { if(i > 0) frag.appendChild(connector()); frag.appendChild(renderNode(nd, arr, i)); });
  if(arr.length) frag.appendChild(connector(true));
  frag.appendChild(addButton(parent === root ? root.children : parent.children));
  return frag;
}
function connector(faint){
  const c = document.createElement('div'); c.className = 'conn';
  const col = faint ? '#2e2046' : '#6a5a8a';
  c.innerHTML = '<svg width="12" height="16"><line x1="6" y1="0" x2="6" y2="13" stroke="' + col + '" stroke-width="2"/><path d="M2 9 L6 14 L10 9" fill="none" stroke="' + col + '" stroke-width="2"/></svg>';
  return c;
}
function kindClass(b){ return b.type === 'container' ? 'container' : b.type === 'draw' ? 'draw' : 'leaf'; }
function nodeLabel(nd, b){ return b.labelFn ? b.labelFn(nd.fields) : b.label; }
function nodePreview(nd, b){
  const c = b.code(nd.fields);
  const line = (b.type === 'container' ? c.open : String(c).split('\n')[0]) || '';
  return line.length > 80 ? line.slice(0, 80) + '…' : line;
}
function renderNode(nd, siblings, idx){
  const b = BLOCKS[nd.blockId];
  const card = document.createElement('div');
  card.className = 'node ' + kindClass(b) + (nd.uid === selectedUid ? ' sel' : '');
  card.dataset.uid = nd.uid;
  const head = document.createElement('div'); head.className = 'node-head';
  if(b.type === 'container'){
    const caret = document.createElement('span'); caret.className = 'node-caret'; caret.textContent = nd.collapsed ? '▸' : '▾';
    caret.onclick = e => { e.stopPropagation(); nd.collapsed = !nd.collapsed; renderTree(); };
    head.appendChild(caret);
  }
  const label = document.createElement('span'); label.className = 'node-label'; label.textContent = nodeLabel(nd, b); head.appendChild(label);
  const ctrls = document.createElement('div'); ctrls.className = 'node-ctrls';
  ctrls.appendChild(ctrlBtn('↑', e => { e.stopPropagation(); move(siblings, idx, -1); }));
  ctrls.appendChild(ctrlBtn('↓', e => { e.stopPropagation(); move(siblings, idx, +1); }));
  ctrls.appendChild(ctrlBtn('⎘', e => { e.stopPropagation(); const copy = reUid(JSON.parse(JSON.stringify(nd))); siblings.splice(idx + 1, 0, copy); renderTree(); }));
  ctrls.appendChild(ctrlBtn('🗑', e => { e.stopPropagation(); siblings.splice(idx, 1); if(nd.uid === selectedUid) selectedUid = null; renderTree(); }));
  head.appendChild(ctrls);
  card.appendChild(head);
  const prev = document.createElement('div'); prev.className = 'node-prev'; prev.textContent = nodePreview(nd, b); card.appendChild(prev);
  card.onclick = e => { if(e.target.closest('.node-ctrls') || e.target.classList.contains('node-caret')) return; select(nd); };
  if(b.type === 'container'){
    if(!nd.collapsed){
      const body = document.createElement('div'); body.className = 'node-body';
      body.appendChild(renderChildren(nd.children, nd));
      card.appendChild(body);
      const close = document.createElement('div'); close.className = 'node-close'; close.textContent = b.code(nd.fields).close; card.appendChild(close);
    } else {
      const c = document.createElement('div'); c.className = 'node-collapsed'; c.textContent = '… ' + (nd.children ? nd.children.length : 0) + ' внутри'; card.appendChild(c);
    }
  }
  return card;
}
function ctrlBtn(t, fn){ const b = document.createElement('button'); b.textContent = t; b.onclick = fn; return b; }

// ── выбор узла + инспектор (Настроить / Разобраться / Объяснить) ──────────────
function findNode(uid, arr){ arr = arr || root.children; for(const nd of arr){ if(nd.uid === uid) return nd; if(nd.children){ const r = findNode(uid, nd.children); if(r) return r; } } return null; }
function select(nd){ selectedUid = nd.uid; ws.querySelectorAll('.node').forEach(el => el.classList.toggle('sel', el.dataset.uid === selectedUid)); renderInspector(nd); persist(); }
function onFieldChange(){ renderGraph(); renderCode(); persist(); }   // граф обновляем, инспектор не трогаем (фокус)

function renderInspector(nd){
  const host = $('#inspector'); if(!host) return;
  nd = nd || (selectedUid ? findNode(selectedUid) : null);
  if(!nd){ selectedUid = null; host.innerHTML = '<div class="insp-body"><div class="insp-empty">Выбери узел слева — здесь настроишь его поля, разберёшься, что он делает, и получишь объяснение.<br><br>Нет узлов? Жми «+ блок» или «пример».</div></div>'; return; }
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
  const title = document.createElement('div'); title.className = 'insp-title'; title.textContent = nodeLabel(nd, b); body.appendChild(title);
  const kind = document.createElement('div'); kind.className = 'insp-kind'; kind.textContent = b.type === 'container' ? 'контейнер · { }' : b.type === 'draw' ? 'рисование' : 'блок'; body.appendChild(kind);
  if(inspTab === 'set') body.appendChild(inspFields(nd, b));
  else if(inspTab === 'learn'){ const p = document.createElement('div'); p.className = 'insp-text'; p.textContent = (b.hintFn ? b.hintFn(nd.fields) : b.hint) || 'подсказки нет'; body.appendChild(p); }
  else body.appendChild(inspWhy(nd, b));
  host.appendChild(body);
}
function inspFields(nd, b){
  if(!(b.fields || []).length){ const e = document.createElement('div'); e.className = 'insp-text'; e.textContent = 'у этого узла нет настроек.'; return e; }
  const box = document.createElement('div');
  (b.fields || []).forEach(f => {
    const row = document.createElement('div'); row.className = 'insp-field';
    const lab = document.createElement('label'); lab.textContent = f.k; row.appendChild(lab);
    if(f.multi){
      const ta = document.createElement('textarea'); ta.className = 'blk-code'; ta.spellcheck = false; ta.value = nd.fields[f.k];
      ta.rows = Math.min(16, String(nd.fields[f.k]).split('\n').length + 1);
      ta.addEventListener('input', () => { nd.fields[f.k] = ta.value; onFieldChange(); });
      row.appendChild(attachHighlight(ta));
    } else {
      const inp = document.createElement('input'); inp.value = nd.fields[f.k]; inp.spellcheck = false;
      inp.addEventListener('input', () => { nd.fields[f.k] = inp.value; onFieldChange(); });
      row.appendChild(inp);
    }
    box.appendChild(row);
  });
  return box;
}
function inspWhy(nd, b){
  const box = document.createElement('div');
  const p = document.createElement('div'); p.className = 'insp-text';
  const hint = (b.hintFn ? b.hintFn(nd.fields) : b.hint) || '';
  const first = hint.split('.')[0];
  p.textContent = 'Это «' + nodeLabel(nd, b) + '». ' + (first ? first + '. ' : '') + (b.type === 'container' ? ('Внутри ' + (nd.children ? nd.children.length : 0) + ' шаг(ов).') : '');
  box.appendChild(p);
  const c = b.code(nd.fields);
  const codeStr = b.type === 'container' ? (c.open + '\n  …\n' + c.close) : String(c);
  const cw = document.createElement('div'); cw.className = 'insp-code';
  const pre = document.createElement('pre'); pre.className = 'code mono'; pre.style.maxHeight = '220px';
  buildHighlight(codeStr).forEach(l => pre.appendChild(l));
  cw.appendChild(pre); box.appendChild(cw);
  return box;
}
function reUid(nd){ nd.uid = uid(); if(nd.children) nd.children.forEach(reUid); return nd; }
function move(arr, i, d){ const j = i + d; if(j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; renderTree(); }

function addButton(targetArr){
  const b = document.createElement('button'); b.className = 'addblk'; b.textContent = '+ блок';
  b.onclick = e => { e.stopPropagation(); openMenu(b, targetArr); };
  return b;
}
function openMenu(anchor, targetArr){
  closeMenu();
  const m = document.createElement('div'); m.className = 'menu'; m.id = '_menu';
  for(const cat of CATS){
    const h = document.createElement('div'); h.className = 'mcat'; h.textContent = cat; m.appendChild(h);
    for(const [id, b] of Object.entries(BLOCKS)){
      if(b.cat !== cat) continue;
      const it = document.createElement('div'); it.className = 'mitem';
      it.innerHTML = '<span class="mi-label">'+b.label+'</span>' + (b.hint ? '<span class="mi-hint">'+b.hint+'</span>' : '');
      it.onclick = () => { const nd = makeNode(id); targetArr.push(nd); closeMenu(); renderTree(); select(nd); };
      m.appendChild(it);
    }
  }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 240) + 'px';
  m.style.top = (r.bottom + window.scrollY + 4) + 'px';
  setTimeout(() => document.addEventListener('mousedown', outside), 0);
}
function outside(e){ const m = $('#_menu'); if(m && !m.contains(e.target)) closeMenu(); }
function closeMenu(){ const m = $('#_menu'); if(m) m.remove(); document.removeEventListener('mousedown', outside); }

// ── генерация кода ────────────────────────────────────────────────────────────
function genLines(arr){
  const out = [];
  for(const nd of arr){
    const b = BLOCKS[nd.blockId];
    if(b.type === 'container'){
      const { open, close } = b.code(nd.fields);
      out.push(open);
      for(const l of genLines(nd.children)) out.push('  ' + l);
      out.push(close);
    } else {
      for(const l of b.code(nd.fields).split('\n')) out.push(l);
    }
  }
  return out;
}
function currentCode(){ return genLines(root.children).join('\n'); }

// лёгкая подсветка кода (для панели)
const KW = new Set(['const','let','function','return','if','else','for','of','while','new','=>']);
const BI = new Set(['console','log','document','querySelector','getContext','addEventListener','map','reduce','forEach','fillRect','innerHTML']);
// код → массив <div class="line"> с раскрашенными спанами (общий для панели и блоков)
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

// обернуть textarea блока раскрашенным <pre> под ним (прозрачный текст поверх)
function attachHighlight(ta){
  const wrap = document.createElement('div'); wrap.className = 'blk-code-wrap';
  const pre = document.createElement('pre'); pre.className = 'blk-hl'; pre.setAttribute('aria-hidden', 'true');
  const sync = () => { pre.innerHTML = ''; buildHighlight(ta.value).forEach(l => pre.appendChild(l)); };
  ta.addEventListener('input', sync);
  ta.addEventListener('scroll', () => { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; });
  wrap.appendChild(pre); wrap.appendChild(ta); sync();
  return wrap;
}

// ── запуск в песочнице ────────────────────────────────────────────────────────
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

// ── кнопки ────────────────────────────────────────────────────────────────────
$('#copy').onclick = () => { navigator.clipboard.writeText(currentCode()); flashBtn($('#copy'), '✓ скопировано', '⧉ копировать'); };
$('#run').onclick = run;

// скачать файл: Blob + ссылка с атрибутом download. Формат = расширение имени
// + MIME-тип Blob (type). Браузер по ним и решает, что это за файл.
function download(name, text, mime){
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function wrapHtml(code){
  return '<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n<title>моя страница</title>\n'
    + '<style>body{margin:12px;font:13px ui-monospace,monospace;color:#F6F4FF;background:#0E0720}'
    + '#log{color:#52F2C9;white-space:pre-wrap}</style>\n</head>\n<body>\n'
    + '<canvas id="c" width="300" height="160" style="background:#140A24;border:1px solid #241638;border-radius:6px"></canvas>\n'
    + '<div id="out"></div>\n<pre id="log"></pre>\n<script>\n'
    + 'var log=document.getElementById("log");var _p=function(){log.textContent+=Array.prototype.join.call(arguments," ")+"\\n";};\n'
    + 'var console={log:_p,error:_p,warn:_p,info:_p};\ntry{\n' + code + '\n}catch(e){log.textContent+="\\u26d4 "+e.message;}\n'
    + '<\/script>\n</body>\n</html>\n';
}
$('#dl').onclick = () => {
  const code = currentCode();
  const fmt = $('#fmt').value;
  const base = ((files[active] && files[active].name) || 'код').replace(/[^\wа-яё.\- ]/gi, '').trim() || 'код';
  if(fmt === 'html') download(base + '.html', wrapHtml(code), 'text/html');
  else if(fmt === 'txt') download(base + '.txt', code, 'text/plain');
  else download(base + '.js', code, 'text/javascript');
  flashBtn($('#dl'), '✓ скачано', '⬇ скачать');
};
function flashBtn(b, on, off){ b.textContent = on; setTimeout(() => b.textContent = off, 1200); }

// ── импорт файла: разбить рабочий JS на вложенные блоки ──────────────────────
// Грубый разбор по фигурным скобкам (с учётом строк/комментариев/скобок).
// Контейнеры { } → блок-контейнер, остальное → строки кода. Код сохраняется
// рабочим (при сборке просто склеивается обратно), сложные конструкции
// (else, цепочки) могут разбиться на части — но запускаются.
function parseLevel(code){
  const nodes = []; const n = code.length; let i = 0, seg = '', paren = 0, brack = 0;
  const pushStmt = txt => { const t = txt.trim(); if(t){ const nd = makeNode('raw'); nd.fields.code = t; nodes.push(nd); } };
  const skipStr = (j, qt) => { j++; while(j < n){ if(code[j] === '\\'){ j += 2; continue; } if(code[j] === qt){ j++; break; } j++; } return j; };
  while(i < n){
    const c = code[i];
    if(c === '"' || c === "'" || c === '`'){ const j = skipStr(i, c); seg += code.slice(i, j); i = j; continue; }
    if(c === '/' && code[i + 1] === '/'){ let j = code.indexOf('\n', i); if(j < 0) j = n; seg += code.slice(i, j); i = j; continue; }
    if(c === '/' && code[i + 1] === '*'){ let j = code.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; seg += code.slice(i, j); i = j; continue; }
    if(c === '('){ paren++; seg += c; i++; continue; }
    if(c === ')'){ paren = Math.max(0, paren - 1); seg += c; i++; continue; }
    if(c === '['){ brack++; seg += c; i++; continue; }
    if(c === ']'){ brack = Math.max(0, brack - 1); seg += c; i++; continue; }
    if(c === '{'){
      const header = seg.trim(); seg = '';
      let depth = 1, j = i + 1, inner = '';
      while(j < n && depth > 0){
        const d = code[j];
        if(d === '"' || d === "'" || d === '`'){ const k = skipStr(j, d); inner += code.slice(j, k); j = k; continue; }
        if(d === '/' && code[j + 1] === '/'){ let k = code.indexOf('\n', j); if(k < 0) k = n; inner += code.slice(j, k); j = k; continue; }
        if(d === '/' && code[j + 1] === '*'){ let k = code.indexOf('*/', j + 2); k = k < 0 ? n : k + 2; inner += code.slice(j, k); j = k; continue; }
        if(d === '{') depth++;
        if(d === '}'){ depth--; if(depth === 0){ j++; break; } }
        inner += d; j++;
      }
      let tail = ''; while(j < n && code[j] !== '\n'){ const done = code[j] === ';'; if(code[j] === '{') break; tail += code[j]; j++; if(done) break; }
      const nd = makeNode('block'); nd.fields.header = header; nd.fields.tail = tail.trim(); nd.children = parseLevel(inner);
      nodes.push(nd); i = j; continue;
    }
    if(c === ';'){ seg += c; pushStmt(seg); seg = ''; i++; continue; }
    if(c === '\n'){ if(paren === 0 && brack === 0){ pushStmt(seg); seg = ''; } else seg += c; i++; continue; }
    seg += c; i++;
  }
  pushStmt(seg);
  return nodes;
}
$('#imp').onclick = () => $('#impfile').click();
$('#impfile').onchange = async e => {
  const f = e.target.files && e.target.files[0]; if(!f) return;
  const text = await f.text();
  if(text.length > 80000){ alert('Файл большой (' + Math.round(text.length / 1024) + ' КБ). Возьми кусок поменьше — иначе разметка будет огромной и медленной.'); return; }
  try { const imported = parseLevel(text); root.children.push(...imported); renderTree(); }   // добавляем, не стираем
  catch(err){ alert('не удалось разобрать: ' + err.message); }
  e.target.value = '';   // чтобы можно было загрузить тот же файл повторно
};

// сохранить сборку как шаблон (появится в разделе «Шаблоны», группа «Из конструктора»)
$('#save').onclick = async () => {
  const code = currentCode();
  if(!code.trim()){ flashBtn($('#save'), 'пусто', '💾 в шаблоны'); return; }
  const title = prompt('Название шаблона:', 'Моя сборка');
  if(title === null) return;
  const r = await fetch('/api/add', { method: 'POST', body: JSON.stringify({ title: title || 'Моя сборка', lang: 'js', group: 'Из конструктора', code, desc: 'собрано в конструкторе' }) }).then(r => r.json()).catch(() => ({}));
  flashBtn($('#save'), r.id ? '✓ в шаблонах' : 'ошибка', '💾 в шаблоны');
};

// «+ из шаблона»: втянуть код шаблона в конструктор как блок «свой код».
// Так шаблоны (в т.ч. загруженные) оказываются в конструкторе.
$('#fromtpl').onclick = async (e) => {
  e.stopPropagation(); closeMenu();
  let list; try { list = await fetch('/api/list').then(r => r.json()); } catch(_){ return; }
  const jsOnly = list.filter(t => (t.lang || 'js') === 'js');   // в конструкторе бежит только JS
  const m = document.createElement('div'); m.className = 'menu'; m.id = '_menu';
  if(!jsOnly.length){ m.innerHTML = '<div class="mcat">нет JS-шаблонов</div>'; }
  const byGroup = {};
  jsOnly.forEach(t => { (byGroup[t.group] = byGroup[t.group] || []).push(t); });
  for(const g of Object.keys(byGroup)){
    const h = document.createElement('div'); h.className = 'mcat'; h.textContent = g; m.appendChild(h);
    byGroup[g].forEach(t => {
      const it = document.createElement('div'); it.className = 'mitem';
      it.innerHTML = '<span class="mi-label">' + t.title + '</span>';
      it.onclick = async () => {
        closeMenu();
        try {
          const tpl = await fetch('/api/template?id=' + encodeURIComponent(t.id)).then(r => r.json());
          const code = (tpl.lines || []).map(line => (line || []).map(tok => tok.v != null ? tok.v : '').join('')).join('\n');
          const nd = makeNode('raw'); nd.fields.code = code; root.children.push(nd); renderTree(); select(nd);
        } catch(_){}
      };
      m.appendChild(it);
    });
  }
  document.body.appendChild(m);
  const r = $('#fromtpl').getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 320) + 'px';
  m.style.top = (r.bottom + window.scrollY + 4) + 'px';
  setTimeout(() => document.addEventListener('mousedown', outside), 0);
};
$('#clear').onclick = () => { selectedUid = null; setRoot({ children: [] }); renderTree(); };
$('#example').onclick = () => {
  selectedUid = null;
  setRoot({ children: [
    { uid: uid(), blockId:'array', fields:{ name:'числа', items:'40, 70, 30, 90, 55' } },
    { uid: uid(), blockId:'func', fields:{ name:'среднее', args:'список' }, children:[
      { uid: uid(), blockId:'reduce', fields:{ name:'с', list:'список', expr:'acc + x' } },
      { uid: uid(), blockId:'ret', fields:{ value:'с / список.length' } },
    ]},
    { uid: uid(), blockId:'call', fields:{ name:'среднее', args:'числа' } },
    { uid: uid(), blockId:'bars', fields:{ values:'40, 70, 30, 90, 55' } },
  ]});
  renderTree();
};

restore();
renderTree();
