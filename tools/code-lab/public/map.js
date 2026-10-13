// Карта: раскладывает шаблоны (/api/list) по 7 уровням архитектуры.
// Уровни — те же «слои», что в схеме знаний: фундамент снизу, предметка сверху.
// Группа шаблона → уровень по таблице ниже; что не попало — в «Прочее».
const LEVELS = [
  { n:1, key:'basics', color:'#B45CFF', name:'Основы языка',
    what:'переменные, условия, циклы, функции, типы — алфавит, без него никуда',
    groups:['JavaScript — основы','Python — основы','Справочник','Одна задача на 3 языках'] },
  { n:2, key:'data', color:'#3DD9FF', name:'Структуры данных',
    what:'массив, объект/словарь, простая база — ЧЕМ и как хранить',
    groups:['JavaScript — данные','База данных (просто)'] },
  { n:3, key:'flow', color:'#52F2C9', name:'Поток данных и функции',
    what:'вход→выход, связывание шагов, события, состояние, отрисовка результата',
    groups:['Как связывать (поток данных)','JavaScript — расчёты','JavaScript — интерактив','Как строятся системы','Рецепты (от задачи к коду)','Отрисовка'] },
  { n:4, key:'arch', color:'#FF8800', name:'Архитектура',
    what:'модули и импорты, библиотеки, серверы, интерфейс — кто кого зовёт',
    groups:['Как файлы образуют систему','Библиотеки','Серверы','Стили страниц'] },
  { n:5, key:'net', color:'#FF2FAE', name:'Данные и сеть',
    what:'fetch, API, JSON, парсеры, обход CORS через прокси',
    groups:['Сеть и запросы','Парсеры'] },
  { n:6, key:'debug', color:'#E8895A', name:'Отладка и тесты',
    what:'найти баг, воспроизвести, проверить — пока без шаблонов, но есть практикум',
    groups:[], link:{ href:'/schema-debug.html', text:'→ практикум по отладке' } },
  { n:7, key:'domain', color:'#9C90C4', name:'Предметка: финансы и математика',
    what:'доходности, риск, корреляции, индикаторы — ЧТО именно считать',
    groups:['Сложная математика','Риск на нескольких активах'] },
];
const LANG_LABEL = { js:'JS', python:'PY', sql:'SQL', css:'CSS', other:'—' };

(async function(){
  let list = [];
  try { list = await fetch('/api/list').then(r => r.json()); } catch(_){
    document.getElementById('sections').innerHTML = '<div class="muted pad">сервер недоступен</div>'; return;
  }
  // группа → уровень
  const g2l = {};
  LEVELS.forEach(L => L.groups.forEach(g => g2l[g] = L.key));
  const byLevel = {}; LEVELS.forEach(L => byLevel[L.key] = []);
  const other = [];
  list.forEach(t => { const k = g2l[t.group]; if(k) byLevel[k].push(t); else other.push(t); });

  // обзор-лесенка
  const ladder = document.getElementById('ladder');
  LEVELS.forEach(L => {
    const cnt = byLevel[L.key].length;
    const b = document.createElement('div'); b.className = 'lband'; b.style.borderLeftColor = L.color;
    b.innerHTML = '<div class="lnum" style="background:' + L.color + '">' + L.n + '</div>'
      + '<div class="lmain"><div class="lname">' + esc(L.name) + '</div><div class="lwhat">' + esc(L.what) + '</div></div>'
      + '<div class="lcount">' + (cnt ? (cnt + ' шабл.') : (L.link ? 'практикум' : '—')) + '</div>';
    b.onclick = () => { const el = document.getElementById('lvl-' + L.key); if(el) el.scrollIntoView({ behavior:'smooth', block:'start' }); };
    ladder.appendChild(b);
  });

  // детальные секции
  const host = document.getElementById('sections');
  LEVELS.forEach(L => {
    const sec = document.createElement('section'); sec.className = 'lsec'; sec.id = 'lvl-' + L.key;
    const h = document.createElement('div'); h.className = 'lsec-h';
    h.innerHTML = '<span class="lsec-dot" style="background:' + L.color + '"></span>'
      + '<span class="lsec-n">уровень ' + L.n + '</span><span class="lsec-name">' + esc(L.name) + '</span>';
    sec.appendChild(h);
    const what = document.createElement('div'); what.className = 'lsec-what'; what.textContent = L.what; sec.appendChild(what);
    const items = byLevel[L.key];
    if(items.length){
      const grid = document.createElement('div'); grid.className = 'cards';
      items.forEach(t => grid.appendChild(card(t)));
      sec.appendChild(grid);
    } else if(L.link){
      const a = document.createElement('a'); a.className = 'lsec-link'; a.href = L.link.href; a.textContent = L.link.text; sec.appendChild(a);
    }
    host.appendChild(sec);
  });

  if(other.length){
    const sec = document.createElement('section'); sec.className = 'lsec';
    sec.innerHTML = '<div class="lsec-h"><span class="lsec-dot" style="background:var(--text3)"></span><span class="lsec-name">Прочее</span></div>';
    const grid = document.createElement('div'); grid.className = 'cards';
    other.forEach(t => grid.appendChild(card(t)));
    sec.appendChild(grid); host.appendChild(sec);
  }
})();

function card(t){
  const a = document.createElement('a'); a.className = 'tcard'; a.href = '/library.html#' + encodeURIComponent(t.id);
  a.innerHTML = '<div class="tcard-h"><span class="tcard-t"></span><span class="tcard-l">' + esc(LANG_LABEL[(t.lang||'other').toLowerCase()] || (t.lang||'').toUpperCase()) + '</span></div>'
    + '<div class="tcard-d"></div><div class="tcard-g"></div>';
  a.querySelector('.tcard-t').textContent = t.title || 'без названия';
  a.querySelector('.tcard-d').textContent = t.desc || '';
  a.querySelector('.tcard-g').textContent = t.group || '';
  return a;
}
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
