// Каталог компонентов по трём осям (по задумке пользователя):
// 1) назначение — основная структура (слева), 2) место в системе и
// 3) технология — фильтры. Внутри категории — подкатегории; крупное
// (компоненты/рецепты) сверху, фрагменты-кирпичики — свёрнуто внизу.
// Теги берём из component.tags, если есть, иначе выводим по ключевым словам.

const PURPOSE = [
  { key:'Интерфейс', lead:'Что видит и с чем взаимодействует пользователь: формы, таблицы, кнопки, рисование, цвета, анимации.',
    kw:['dom','форм','ввод','кнопк','таблиц','карточк','модал','меню','уведомл','поиск','canvas','цвет','анимац','стил','css','верстк','grid','flex','клик','наведен','ползун','slider','рисов','отрисов','svg','экран','курсор','градиент','частиц'] },
  { key:'Работа с данными', lead:'Как данные создаются, проверяются, хранятся и извлекаются: массивы, объекты, CRUD, SQL, кэш, импорт/экспорт.',
    kw:['массив','объект','словар','строк','crud','база','sql','хранилищ','localstorage','кэш','миграц','импорт','экспорт','модел','схем','сохран','reduce','.map','filter','сортиров','фильтр','очеред','стек','дек','множеств'] },
  { key:'Интеграции', lead:'Обмен данными с другими системами: HTTP, REST, вебхуки, прокси, сторонние сервисы.',
    kw:['fetch','api','http','rest','запрос','вебхук','webhook','почт','платеж','сторонн','таймаут','прокси','cors','moex','гир бо'] },
  { key:'Файлы и документы', lead:'Чтение и создание файлов: CSV, Excel, PDF, парсеры.',
    kw:['csv','xlsx','excel','pdf','docx','sheetjs','mammoth','разбор файл','чтение файл'] },
  { key:'Автоматизация', lead:'Работа по расписанию или вне основного запроса: таймеры, планировщик, пакетная обработка.',
    kw:['расписан','планировщ','фонов','периодическ','cron','setinterval','пакет','батч','batch'] },
  { key:'Диагностика и тестирование', lead:'Как проверять систему и искать причины сбоев: ошибки, логи, тесты, трассировка.',
    kw:['тест','логир','ошибк','трассиров','монитор','debug','отладк','исключ','assert'] },
  { key:'Запуск и инфраструктура', lead:'Как проект настраивается и запускается: сервер, маршруты, модули, конфигурация, сборка.',
    kw:['сервер','запуск','конфиг','зависимост','сборк','контейнер','env','порт','node','flask','маршрут','роут','модул','импорт','export'] },
];
const PURPOSE_ORDER = ['Интеграции','Файлы и документы','Автоматизация','Диагностика и тестирование','Запуск и инфраструктура','Интерфейс','Работа с данными'];

const SUBCATS = {
  'Интерфейс':[
    ['Формы и ввод',['форм','input','ввод','checkbox','select','ползун','range','поле','type=']],
    ['Таблицы и списки',['таблиц','tbody','список строк']],
    ['Рисование (Canvas/SVG)',['canvas','svg','рисов','градиент','fillrect','filltext','arc','lineto','moveto','drawimage','кадр','частиц','clearrect','столбик']],
    ['Цвета',['цвет','hsl','rgba','gradient','палитр']],
    ['Анимация и время',['анимац','requestanimationframe','время']],
    ['События',['событ','клик','keydown','keyup','клавиш','мыш','наведен','курсор']],
    ['DOM-элементы',['dom','queryselector','createelement','classlist','setattribute','textcontent','innerhtml','style','append','надпис']],
  ],
  'Работа с данными':[
    ['Массивы и объекты',['массив','объект','map','reduce','filter','foreach']],
    ['Строки',['строк','split','replace','join']],
    ['Хранилище',['localstorage','хранилищ','кэш','setitem','сохран']],
    ['База и CRUD',['crud','база','добав','найд','удал']],
    ['Сортировка и фильтры',['сортиров','фильтр','sort']],
    ['Структуры',['стек','очеред','дек','множеств','set']],
    ['Основы',['переменн','услови','цикл','функц','тип','ветвлен','switch','break','continue','return']],
  ],
  'Интеграции':[
    ['HTTP-запросы',['fetch','http','запрос','анатом']],
    ['Разбор ответа',['парсер','columns','разбор','ответ api']],
    ['Прокси и CORS',['прокси','cors']],
    ['Цепочки и параллельно',['цепочк','promise','await','параллель']],
  ],
  'Файлы и документы':[['CSV',['csv']],['Excel',['xlsx','excel','sheetjs']],['Разбор',['парсер','разбор','parse']]],
  'Автоматизация':[['Таймеры',['таймер','интервал','setinterval']],['Планировщик',['расписан','планировщ','cron']],['Пакетная обработка',['пакет','батч','batch']]],
  'Диагностика и тестирование':[['Ошибки',['ошибк','try','catch','исключ']],['Логи',['лог','console']],['Тесты',['тест']],['Отладка',['отладк','debug','трассиров']]],
  'Запуск и инфраструктура':[['Серверы',['сервер','node','flask','порт']],['Маршруты',['маршрут','роут']],['Модули и импорты',['модул','импорт','export','файл']],['Конфигурация',['конфиг','env','сборк','зависимост']]],
};

const TECH_LABEL = { js:'JavaScript', python:'Python', css:'HTML/CSS', sql:'SQL', other:'—' };
const PLACES = ['Браузер','Сервер','Хранилище','Внешние сервисы','Общие компоненты'];
const TECHS  = ['JavaScript','Python','HTML/CSS','SQL'];

function hay(t){ return ((t.group||'')+' '+(t.title||'')+' '+(t.desc||'')).toLowerCase(); }
function purposeOf(t){
  if(t.comp && t.comp.tags && t.comp.tags.purpose && t.comp.tags.purpose.length) return t.comp.tags.purpose[0];
  const h = hay(t);
  for(const key of PURPOSE_ORDER){ const P = PURPOSE.find(x=>x.key===key); if(P.kw.some(w=>h.includes(w))) return key; }
  return 'Работа с данными';
}
function placesOf(t){
  if(t.comp && t.comp.tags && t.comp.tags.runtime && t.comp.tags.runtime.length){
    const m = t.comp.tags.runtime.map(x=>{ const l=x.toLowerCase(); if(/брауз|dom/.test(l))return'Браузер'; if(/сервер|node|flask/.test(l))return'Сервер'; if(/хранил|sql|кэш|файл/.test(l))return'Хранилище'; if(/внеш|api|сервис/.test(l))return'Внешние сервисы'; return'Общие компоненты'; });
    return [...new Set(m)];
  }
  const h = hay(t), L = t.lang, r = new Set();
  if(L==='sql' || /\bsql\b|localstorage|кэш|хранилищ|\bбаза\b/.test(h)) r.add('Хранилище');
  if(/fetch|\bapi\b|http|запрос|вебхук|прокси|moex|гир бо|почт|платеж/.test(h)) r.add('Внешние сервисы');
  if(/node|flask|сервер|маршрут|\bроут|порт/.test(h)) r.add('Сервер');
  if(L==='css' || L==='js' || /dom|canvas|форм|кнопк|клик|экран|стил|анимац|цвет|таблиц/.test(h)) r.add('Браузер');
  if(L==='python' && !r.has('Сервер')) r.add('Сервер');
  if(!r.size) r.add('Общие компоненты');
  return [...r];
}
function techsOf(t){
  if(t.comp && t.comp.tags && t.comp.tags.technology && t.comp.tags.technology.length) return t.comp.tags.technology;
  const r = [TECH_LABEL[(t.lang||'other').toLowerCase()] || (t.lang||'').toUpperCase()];
  if(/fetch|\bapi\b|http|rest/.test(hay(t))) r.push('HTTP/REST');
  return r;
}
function typeOf(t){
  if(t.comp && t.comp.type) return t.comp.type;
  const h = hay(t);
  if(/→/.test(t.title||'') || /рецепт|как связыв|как строятся|конвейер/.test(h)) return 'recipe';
  return (t.nlines||0) >= 14 ? 'component' : 'fragment';
}
function subOf(t, purpose){
  if(t.comp && t.comp.subcat) return t.comp.subcat;   // явная подкатегория из метаданных
  const defs = SUBCATS[purpose] || []; const h = hay(t);
  for(const [name, kws] of defs){ if(kws.some(w=>h.includes(w))) return name.trim(); }
  return 'Разное';
}
const TYPE_RU = { fragment:'фрагмент', component:'компонент', recipe:'рецепт', module:'модуль' };
const TYPE_RANK = { recipe:0, module:1, component:2, fragment:3 };

let ALL = [], active = PURPOSE[0].key, fPlace = '', fTech = '', query = '', selCardId = null, axis = 'purpose', activeCol = null;
function collectionsOf(t){ return (t.comp && Array.isArray(t.comp.collections)) ? t.comp.collections : []; }
function allCollections(){ const s = new Set(); ALL.forEach(t => collectionsOf(t).forEach(c => s.add(c))); return [...s].sort((a, b) => a.localeCompare(b, 'ru')); }
function countCol(name){ return name === 'Без раздела' ? ALL.filter(t => !collectionsOf(t).length).length : ALL.filter(t => collectionsOf(t).includes(name)).length; }
async function setCollections(t, cols){
  t.comp = t.comp || {}; t.comp.collections = cols;
  await fetch('/api/edit', { method:'POST', body: JSON.stringify({ id: t.id, collections: cols }) }).catch(() => {});
}

async function loadAll(){
  try { ALL = await fetch('/api/list').then(r=>r.json()); } catch(_){ document.getElementById('sections').innerHTML='<div class="empty">сервер недоступен</div>'; return; }
  ALL.forEach(t => { t._purpose = purposeOf(t); t._places = placesOf(t); t._techs = techsOf(t); t._type = typeOf(t); });
  renderCats(); renderFilters(); render();
}
loadAll();

function renderCats(){
  const box = document.getElementById('pcats'); box.innerHTML='';
  if(axis === 'custom'){ renderColCats(box); return; }
  PURPOSE.forEach(P => {
    const n = ALL.filter(t=>t._purpose===P.key).length;
    const d = document.createElement('div'); d.className='pcat'+(P.key===active?' on':'');
    d.innerHTML = '<span class="pn">'+esc(P.key)+'</span><span class="pc">'+n+'</span>';
    d.onclick = () => { active=P.key; fPlace=''; fTech=''; query=''; document.getElementById('q').value=''; renderCats(); renderFilters(); render(); };
    box.appendChild(d);
  });
}
function renderFilters(){
  const mk = (host, items, cur, set) => {
    const h = document.getElementById(host); h.innerHTML='';
    const all = chip('все', cur===''); all.onclick=()=>{ set(''); renderFilters(); render(); }; h.appendChild(all);
    items.forEach(it=>{ const c=chip(it, cur===it); c.onclick=()=>{ set(cur===it?'':it); renderFilters(); render(); }; h.appendChild(c); });
  };
  mk('placeF', PLACES, fPlace, v=>fPlace=v);
  mk('techF', TECHS, fTech, v=>fTech=v);
}
function chip(text, on){ const s=document.createElement('span'); s.className='fchip'+(on?' on':''); s.textContent=text; return s; }

document.getElementById('q').oninput = e => { query = e.target.value.trim().toLowerCase(); render(); };

function render(){
  if(axis === 'custom') return renderCustom();
  const P = PURPOSE.find(x=>x.key===active);
  document.getElementById('cName').textContent = active;
  document.getElementById('cLead').textContent = P.lead;
  let items = ALL.filter(t=>t._purpose===active);
  if(fPlace) items = items.filter(t=>t._places.includes(fPlace));
  if(fTech) items = items.filter(t=>t._techs.includes(fTech));
  if(query) items = items.filter(t=>((t.title||'')+' '+(t.desc||'')).toLowerCase().includes(query));
  const host = document.getElementById('sections'); host.innerHTML='';
  if(!items.length){ host.innerHTML='<div class="empty">здесь пока ничего нет под этот фильтр</div>'; return; }
  // по подкатегориям
  const bySub = {}; items.forEach(t=>{ const s=subOf(t,active); (bySub[s]=bySub[s]||[]).push(t); });
  const order = (SUBCATS[active]||[]).map(x=>x[0].trim()).concat(['Разное']);
  const subs = Object.keys(bySub).sort((a,b)=>{ const ia=order.indexOf(a), ib=order.indexOf(b); return (ia<0?99:ia)-(ib<0?99:ib); });
  subs.forEach(sub => {
    const list = bySub[sub].sort((a,b)=>(TYPE_RANK[a._type]-TYPE_RANK[b._type]));
    const big = list.filter(t=>t._type!=='fragment');
    const frags = list.filter(t=>t._type==='fragment');
    const sec = document.createElement('div'); sec.className='subsec';
    sec.innerHTML = '<div class="subh">'+esc(sub)+' <span class="sc">'+list.length+'</span></div>';
    const grid = document.createElement('div'); grid.className='grid';
    big.forEach(t=>grid.appendChild(card(t)));
    sec.appendChild(grid);
    if(frags.length){
      const tog = document.createElement('div'); tog.className='frag-toggle'; tog.textContent='▸ кирпичики-фрагменты ('+frags.length+')';
      const fg = document.createElement('div'); fg.className='grid'; fg.style.display='none';
      frags.forEach(t=>fg.appendChild(card(t)));
      tog.onclick=()=>{ const open=fg.style.display==='none'; fg.style.display=open?'grid':'none'; tog.textContent=(open?'▾':'▸')+' кирпичики-фрагменты ('+frags.length+')'; };
      sec.append(tog, fg);
    }
    host.appendChild(sec);
  });
}

function card(t){
  const a = document.createElement('a'); a.className='card'+(t.id===selCardId?' sel':''); a.href='/component.html?id='+encodeURIComponent(t.id); a.dataset.id=t.id;
  const warn = t.comp && t.comp.safety && t.comp.safety.level && t.comp.safety.level!=='ok';
  const top = '<div class="card-top"><span class="ctype '+t._type+'">'+ (TYPE_RU[t._type]||t._type) +'</span><span class="ctitle"></span></div>';
  const io = (t.comp && (t.comp.input||t.comp.output)) ? '<div class="cio"><span class="i"></span><span class="a">→</span><span class="o"></span></div>' : '';
  const tags = '<div class="ctags">'
    + '<span class="tg">'+esc(t._places[0]||'')+'</span>'
    + '<span class="tg">'+esc((t._techs[0]||''))+'</span>'
    + (warn?'<span class="tg warnflag">⚠ риск</span>':'')
    + '</div>';
  a.innerHTML = top + '<div class="cdesc"></div>' + io + tags + '<div class="ccols"></div>'
    + '<div class="cact"><span class="cbtn" data-x="use">Открыть</span><span class="cbtn" data-x="ctor">→ в конструктор</span>'
    + '<span class="cbtn" data-x="col" title="в мой раздел">🏷</span><span class="cbtn" data-x="desc" title="описание">📝</span><span class="cbtn" data-x="ren" title="переименовать">✎</span><span class="cbtn del" data-x="del" title="удалить">🗑</span></div>';
  a.querySelector('.ctitle').textContent = t.title || t.id;
  a.querySelector('.cdesc').innerHTML = descFmt(t.desc || '');
  fillCols(a, t);
  a.querySelector('[data-x="col"]').onclick = e => { e.preventDefault(); e.stopPropagation(); collectionMenu(t, e.target); };
  if(io){ a.querySelector('.cio .i').textContent = t.comp.input||'—'; a.querySelector('.cio .o').textContent = t.comp.output||'—'; }
  a.querySelector('[data-x="ctor"]').onclick = e => { e.preventDefault(); e.stopPropagation(); toConstructor(t); };
  a.querySelector('[data-x="use"]').onclick = e => { e.preventDefault(); e.stopPropagation(); location.href = a.href; };
  // клик по карточке — выделить (для удаления по Delete); двойной — открыть
  a.addEventListener('click', e => { if(e.target.closest('.cbtn')) return; e.preventDefault(); selCardId = t.id; markCardSel(); });
  a.addEventListener('dblclick', e => { if(e.target.closest('.cbtn')) return; location.href = a.href; });
  a.querySelector('[data-x="ren"]').onclick = async e => {
    e.preventDefault(); e.stopPropagation();
    const v = prompt('Новое понятное название (без англ. жаргона, если можно):', t.title || '');
    if(v == null || v.trim() === '' || v === t.title) return;
    const r = await fetch('/api/edit', { method:'POST', body: JSON.stringify({ id: t.id, title: v.trim() }) }).then(r=>r.json()).catch(()=>({}));
    if(r.ok){ t.title = v.trim(); render(); }
  };
  a.querySelector('[data-x="desc"]').onclick = e => { e.preventDefault(); e.stopPropagation(); editDescModal(t); };
  a.querySelector('[data-x="del"]').onclick = e => { e.preventDefault(); e.stopPropagation(); deleteById(t.id, t.title); };
  return a;
}
// дописать/изменить описание карточки (чтобы не забывать, что это)
function editDescModal(t){
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = '<div class="modal" style="max-width:560px"><h3>Описание</h3>'
    + '<p class="mh">Своими словами: что это и когда брать. Сохранится на карточке и в подсказке палитры.</p>'
    + '<div class="mfield"><label>' + esc(t.title || '') + '</label><textarea id="d-desc" style="min-height:130px" spellcheck="false"></textarea></div>'
    + '<div class="desc-tools"><button type="button" class="btn" id="d-chip">⟨⟩ код в плашку</button>'
    + '<span class="desc-hint">`код` в обратных кавычках — цветная плашка, блок — в тройных ```</span></div>'
    + '<div class="desc-prev-wrap"><div class="desc-prev-h">как будет выглядеть</div><div class="desc-prev" id="d-prev"></div></div>'
    + '<div class="mbtns"><button class="btn ok" id="d-save">Сохранить</button><button class="btn" id="d-cancel">Отмена</button></div><div class="merr" id="d-err"></div></div>';
  document.body.appendChild(bg);
  const $$ = s => bg.querySelector(s);
  $$('#d-desc').value = t.desc || '';
  $$('#d-desc').focus();
  const prev = () => { $$('#d-prev').innerHTML = descFmt($$('#d-desc').value) || '<span class="muted">пусто</span>'; };
  prev(); $$('#d-desc').addEventListener('input', prev);
  $$('#d-chip').onclick = () => { wrapBackticks($$('#d-desc')); prev(); };
  bg.onclick = e => { if(e.target === bg) bg.remove(); };
  $$('#d-cancel').onclick = () => bg.remove();
  $$('#d-save').onclick = async () => {
    const v = $$('#d-desc').value;
    $$('#d-save').textContent = 'сохраняю…';
    const r = await fetch('/api/edit', { method:'POST', body: JSON.stringify({ id: t.id, desc: v }) }).then(r=>r.json()).catch(()=>({}));
    if(r.ok){ t.desc = v; bg.remove(); render(); } else { $$('#d-err').textContent = 'не сохранилось'; $$('#d-save').textContent = 'Сохранить'; }
  };
}
function markCardSel(){ document.querySelectorAll('.card').forEach(el => el.classList.toggle('sel', el.dataset.id === selCardId)); }
async function deleteById(id, label){
  if(!confirm('Удалить компонент «' + (label || id) + '» навсегда?')) return;
  const r = await fetch('/api/delete', { method:'POST', body: JSON.stringify({ id }) }).then(r=>r.json()).catch(()=>({}));
  if(r.ok){ ALL = ALL.filter(x => x.id !== id); if(selCardId === id) selCardId = null; renderCats(); render(); }
}
// клик по карточке выделяет её; Delete/Backspace удаляет выделенную
document.addEventListener('keydown', e => {
  if(e.key !== 'Delete' && e.key !== 'Backspace') return;
  if(!selCardId) return;
  const ae = document.activeElement; if(ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return;
  if(document.querySelector('.modal-bg')) return;
  const t = ALL.find(x => x.id === selCardId); if(!t) return;
  e.preventDefault(); deleteById(selCardId, t.title);
});

async function toConstructor(t){
  let code = '';
  try { const full = await fetch('/api/template?id='+encodeURIComponent(t.id)).then(r=>r.json());
    code = full.component && full.component.views && full.component.views.use && full.component.views.use.code
      ? full.component.views.use.code.content
      : (full.lines||[]).map(l=>(l||[]).map(k=>k.v!=null?k.v:'').join('')).join('\n');
  } catch(_){ return; }
  const LS='codelab_graph'; let g={nodes:[],edges:[]};
  try{ const s=JSON.parse(localStorage.getItem(LS)||'null'); if(s&&Array.isArray(s.nodes)) g=s; }catch(_){}
  const uid=()=>Math.random().toString(36).slice(2,8);
  const n=g.nodes.length;
  g.nodes.push({ id:uid(), blockId:'raw', fields:{code}, x:60+(n%6)*30, y:60+(n%6)*30, title:(t.title||'компонент').slice(0,40) });
  try{ localStorage.setItem(LS, JSON.stringify(g)); }catch(_){}
  location.href='/constructor.html';
}
// ── добавить компонент в любой раздел (в установленном формате) ──────────────
const TECH2LANG = { JavaScript:'js', Python:'python', 'HTML/CSS':'css', SQL:'sql' };
function openAddForm(){
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  const purposeOpts = PURPOSE.map(p => '<option>' + esc(p.key) + '</option>').join('');
  const techOpts = TECHS.map(t => '<option>' + t + '</option>').join('');
  bg.innerHTML = '<div class="modal">'
    + '<h3>Новый компонент</h3><p class="mh">Заполни в общем формате — он ляжет в выбранный раздел каталога и будет доступен в конструкторе.</p>'
    + '<div class="mrow"><div class="mfield"><label>Назначение (раздел)</label><select id="m-purpose">' + purposeOpts + '</select></div>'
    + '<div class="mfield"><label>Подкатегория</label><select id="m-sub"></select></div></div>'
    + '<div class="mrow"><div class="mfield"><label>Название (по-русски)</label><input id="m-title" placeholder="например: Объект ⇄ текст (сохранить/прочитать)"></div>'
    + '<div class="mfield"><label>Технология</label><select id="m-tech">' + techOpts + '</select></div></div>'
    + '<div class="mfield"><label>Что делает</label><input id="m-desc" placeholder="коротко: зачем этот кусок"><span class="desc-hint">`код` в обратных кавычках — цветная плашка</span></div>'
    + '<div class="mrow"><div class="mfield"><label>Вход (необязательно)</label><input id="m-in" placeholder="что принимает"></div>'
    + '<div class="mfield"><label>Выход (необязательно)</label><input id="m-out" placeholder="что отдаёт"></div></div>'
    + '<div class="mfield"><label>Код</label><textarea id="m-code" spellcheck="false" placeholder="вставь код сюда"></textarea></div>'
    + '<div class="m-dup" id="m-dup" style="display:none"></div>'
    + '<div class="mbtns"><button class="btn ok" id="m-save">Сохранить в каталог</button><button class="btn" id="m-cancel">Отмена</button></div>'
    + '<div class="merr" id="m-err"></div></div>';
  document.body.appendChild(bg);
  const $$ = s => bg.querySelector(s);
  const fillSubs = () => {
    const pk = $$('#m-purpose').value;
    const subs = (SUBCATS[pk] || []).map(x => x[0]).concat(['Разное']);
    $$('#m-sub').innerHTML = subs.map(s => '<option>' + esc(s) + '</option>').join('');
  };
  fillSubs(); $$('#m-purpose').onchange = fillSubs;
  bg.onclick = e => { if(e.target === bg) bg.remove(); };
  $$('#m-cancel').onclick = () => bg.remove();
  // если название совпадает с существующим — предложим обновить, а не плодить дубль
  const findDup = () => { const t = $$('#m-title').value.trim().toLowerCase(), lang = TECH2LANG[$$('#m-tech').value] || 'js'; return t && ALL.find(x => (x.title||'').trim().toLowerCase() === t && (x.lang||'js') === lang); };
  const refreshDup = () => {
    const d = findDup(), box = $$('#m-dup');
    if(d){ box.style.display = 'block'; box.innerHTML = 'Компонент «' + esc(d.title) + '» уже есть. <label class="m-dup-lbl"><input type="checkbox" id="m-asnew"> создать новый, а не обновлять</label>';
      $$('#m-save').textContent = 'Обновить существующий'; }
    else { box.style.display = 'none'; box.innerHTML = ''; $$('#m-save').textContent = 'Сохранить в каталог'; }
  };
  $$('#m-title').addEventListener('input', refreshDup);
  $$('#m-tech').addEventListener('change', refreshDup);
  $$('#m-save').onclick = async () => {
    const title = $$('#m-title').value.trim(), code = $$('#m-code').value;
    if(!title){ $$('#m-err').textContent = 'впиши название'; return; }
    if(!code.trim()){ $$('#m-err').textContent = 'впиши код'; return; }
    const tech = $$('#m-tech').value, purpose = $$('#m-purpose').value, subcat = $$('#m-sub').value;
    const component = { type:'component', tags:{ purpose:[purpose], technology:[tech], runtime:[] }, subcat,
      summary:{ input: $$('#m-in').value.trim(), output: $$('#m-out').value.trim(), dependencies:[], requirements:[] } };
    const body = { title, lang: TECH2LANG[tech] || 'js', group: subcat, desc: $$('#m-desc').value.trim(), code, component };
    const dup = findDup(), asNew = $$('#m-asnew') && $$('#m-asnew').checked;
    $$('#m-save').textContent = 'сохраняю…';
    let r;
    if(dup && !asNew) r = await fetch('/api/edit', { method:'POST', body: JSON.stringify(Object.assign({ id: dup.id }, body)) }).then(x=>x.json()).catch(()=>({}));
    else r = await fetch('/api/add', { method:'POST', body: JSON.stringify(body) }).then(x=>x.json()).catch(()=>({}));
    if(r.id || r.ok){ bg.remove(); active = purpose; loadAll(); }
    else { $$('#m-err').textContent = 'не сохранилось: ' + (r.error || 'ошибка'); refreshDup(); }
  };
}
document.getElementById('addComp').onclick = openAddForm;

// сворачивание левой колонки с разделами (состояние запоминается)
(function(){
  const cat = document.getElementById('cat'), btn = document.getElementById('sideToggle');
  let off = false; try { off = localStorage.getItem('codelab_cat_side') === 'off'; } catch(_){}
  const apply = () => { cat.classList.toggle('side-off', off); if(btn) btn.title = off ? 'показать разделы' : 'свернуть разделы'; };
  apply();
  if(btn) btn.onclick = () => { off = !off; try { localStorage.setItem('codelab_cat_side', off ? 'off' : 'on'); } catch(_){} apply(); };
})();

// ── своя классификация: переключатель оси + разделы ──────────────────────────
document.getElementById('axisToggle').querySelectorAll('button').forEach(b => {
  b.onclick = () => {
    axis = b.dataset.axis;
    document.getElementById('axisToggle').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    selCardId = null; renderCats(); renderFilters(); render();
  };
});
function renderColCats(box){
  const names = allCollections().concat(['Без раздела']);
  if(!activeCol || !names.includes(activeCol)) activeCol = names[0];
  names.forEach(name => {
    const d = document.createElement('div'); d.className = 'pcat' + (name === activeCol ? ' on' : '');
    d.innerHTML = '<span class="pn">' + esc(name) + '</span><span class="pc">' + countCol(name) + '</span>';
    d.onclick = () => { activeCol = name; fPlace = ''; fTech = ''; query = ''; const q = document.getElementById('q'); if(q) q.value = ''; renderCats(); renderFilters(); render(); };
    box.appendChild(d);
  });
  if(!allCollections().length){ const h = document.createElement('div'); h.className = 'cat-hint'; h.style.padding = '8px 6px'; h.textContent = 'Пока нет своих разделов. На карточке жми 🏷 → «новый раздел».'; box.appendChild(h); }
}
function renderCustom(){
  document.getElementById('cName').textContent = 'Моя классификация · ' + (activeCol || '');
  document.getElementById('cLead').textContent = 'Твои разделы. Назначай карточки через 🏷. «Без раздела» — ещё не разложенное. Delete — удалить выделенную.';
  let items = activeCol === 'Без раздела' ? ALL.filter(t => !collectionsOf(t).length) : ALL.filter(t => collectionsOf(t).includes(activeCol));
  if(fPlace) items = items.filter(t => t._places.includes(fPlace));
  if(fTech) items = items.filter(t => t._techs.includes(fTech));
  if(query) items = items.filter(t => ((t.title || '') + ' ' + (t.desc || '')).toLowerCase().includes(query));
  const host = document.getElementById('sections'); host.innerHTML = '';
  if(!items.length){ host.innerHTML = '<div class="empty">здесь пусто — разложи карточки сюда через 🏷</div>'; return; }
  items.sort((a, b) => TYPE_RANK[a._type] - TYPE_RANK[b._type]);
  const grid = document.createElement('div'); grid.className = 'cards'; items.forEach(t => grid.appendChild(card(t))); host.appendChild(grid);
}
function fillCols(cardEl, t){
  const box = cardEl.querySelector('.ccols'); if(!box) return; box.innerHTML = '';
  collectionsOf(t).forEach(c => box.appendChild(el('span', 'ccol', c)));
}
function collectionMenu(t, anchor){
  closeColMenu(false);
  const m = document.createElement('div'); m.className = 'colmenu'; m.id = '_colmenu';
  m.innerHTML = '<div class="cm-h">в мой раздел</div>';
  const cur = new Set(collectionsOf(t));
  allCollections().forEach(name => {
    const it = document.createElement('div'); it.className = 'cm-i';
    it.innerHTML = '<span class="ck">' + (cur.has(name) ? '✓' : '') + '</span><span>' + esc(name) + '</span>';
    it.onclick = async () => {
      if(cur.has(name)) cur.delete(name); else cur.add(name);
      it.querySelector('.ck').textContent = cur.has(name) ? '✓' : '';
      await setCollections(t, [...cur]); const cardEl = anchor.closest('.card'); if(cardEl) fillCols(cardEl, t);
    };
    m.appendChild(it);
  });
  const nw = document.createElement('div'); nw.className = 'cm-new';
  nw.innerHTML = '<input placeholder="новый раздел…"><button>+</button>';
  const add = async () => { const v = nw.querySelector('input').value.trim(); if(!v) return; cur.add(v); await setCollections(t, [...cur]); closeColMenu(true); };
  nw.querySelector('button').onclick = add;
  nw.querySelector('input').addEventListener('keydown', e => { if(e.key === 'Enter') add(); });
  m.appendChild(nw);
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 230) + 'px'; m.style.top = (r.bottom + window.scrollY + 4) + 'px';
  setTimeout(() => document.addEventListener('mousedown', colOutside), 0);
}
function colOutside(e){ const m = document.getElementById('_colmenu'); if(m && !m.contains(e.target)) closeColMenu(true); }
function closeColMenu(refresh){ const m = document.getElementById('_colmenu'); if(m) m.remove(); document.removeEventListener('mousedown', colOutside); if(refresh){ renderCats(); render(); } }

function el(tag, cls, text){ const e = document.createElement(tag); if(cls) e.className = cls; if(text != null) e.textContent = text; return e; }
function esc(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
// обернуть выделение в textarea обратными кавычками (плашка кода)
function wrapBackticks(ta){
  const a = ta.selectionStart, b = ta.selectionEnd, v = ta.value, sel = v.slice(a, b) || 'код';
  ta.value = v.slice(0, a) + '`' + sel + '`' + v.slice(b);
  ta.focus(); ta.selectionStart = a + 1; ta.selectionEnd = a + 1 + sel.length;
  ta.dispatchEvent(new Event('input'));
}
// описание с кодом: `код` → цветная плашка, ```блок``` → цветной блок
function descFmt(s){
  s = String(s == null ? '' : s);
  const blocks = [];
  s = s.replace(/```([\s\S]*?)```/g, (m, c) => { blocks.push(c.replace(/^\n+|\n+$/g, '')); return '\u0001' + (blocks.length - 1) + '\u0001'; });
  let html = esc(s).replace(/`([^`\n]+)`/g, (m, c) => '<code class="desc-chip">' + c + '</code>').replace(/\n/g, '<br>');
  return html.replace(/\u0001(\d+)\u0001/g, (m, i) => '<pre class="desc-code">' + esc(blocks[+i]) + '</pre>');
}
