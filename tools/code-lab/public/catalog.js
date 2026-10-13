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
  const defs = SUBCATS[purpose] || []; const h = hay(t);
  for(const [name, kws] of defs){ if(kws.some(w=>h.includes(w))) return name.trim(); }
  return 'Разное';
}
const TYPE_RU = { fragment:'фрагмент', component:'компонент', recipe:'рецепт', module:'модуль' };
const TYPE_RANK = { recipe:0, module:1, component:2, fragment:3 };

let ALL = [], active = PURPOSE[0].key, fPlace = '', fTech = '', query = '';

(async function(){
  try { ALL = await fetch('/api/list').then(r=>r.json()); } catch(_){ document.getElementById('sections').innerHTML='<div class="empty">сервер недоступен</div>'; return; }
  ALL.forEach(t => { t._purpose = purposeOf(t); t._places = placesOf(t); t._techs = techsOf(t); t._type = typeOf(t); });
  renderCats(); renderFilters(); render();
})();

function renderCats(){
  const box = document.getElementById('pcats'); box.innerHTML='';
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
  const a = document.createElement('a'); a.className='card'; a.href='/component.html?id='+encodeURIComponent(t.id);
  const warn = t.comp && t.comp.safety && t.comp.safety.level && t.comp.safety.level!=='ok';
  const top = '<div class="card-top"><span class="ctype '+t._type+'">'+ (TYPE_RU[t._type]||t._type) +'</span><span class="ctitle"></span></div>';
  const io = (t.comp && (t.comp.input||t.comp.output)) ? '<div class="cio"><span class="i"></span><span class="a">→</span><span class="o"></span></div>' : '';
  const tags = '<div class="ctags">'
    + '<span class="tg">'+esc(t._places[0]||'')+'</span>'
    + '<span class="tg">'+esc((t._techs[0]||''))+'</span>'
    + (warn?'<span class="tg warnflag">⚠ риск</span>':'')
    + '</div>';
  a.innerHTML = top + '<div class="cdesc"></div>' + io + tags
    + '<div class="cact"><span class="cbtn" data-x="use">Открыть</span><span class="cbtn" data-x="ctor">→ в конструктор</span></div>';
  a.querySelector('.ctitle').textContent = t.title || t.id;
  a.querySelector('.cdesc').textContent = t.desc || '';
  if(io){ a.querySelector('.cio .i').textContent = t.comp.input||'—'; a.querySelector('.cio .o').textContent = t.comp.output||'—'; }
  a.querySelector('[data-x="ctor"]').onclick = e => { e.preventDefault(); e.stopPropagation(); toConstructor(t); };
  a.querySelector('[data-x="use"]').onclick = e => { e.preventDefault(); location.href = a.href; };
  return a;
}

async function toConstructor(t){
  let code = '';
  try { const full = await fetch('/api/template?id='+encodeURIComponent(t.id)).then(r=>r.json());
    code = full.component && full.component.views && full.component.views.use && full.component.views.use.code
      ? full.component.views.use.code.content
      : (full.lines||[]).map(l=>(l||[]).map(k=>k.v!=null?k.v:'').join('')).join('\n');
  } catch(_){ return; }
  const LS='codelab_ctor_files'; let store={files:[],active:0};
  try{ const s=JSON.parse(localStorage.getItem(LS)||'null'); if(s&&Array.isArray(s.files)) store=s; }catch(_){}
  const uid=()=>Math.random().toString(36).slice(2,8);
  store.files.push({ name:(t.title||'компонент').slice(0,40), root:{children:[{uid:uid(),blockId:'raw',fields:{code}}]} });
  store.active=store.files.length-1;
  try{ localStorage.setItem(LS, JSON.stringify(store)); }catch(_){}
  location.href='/constructor.html';
}
function esc(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
