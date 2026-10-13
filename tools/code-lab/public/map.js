// Карта: раскладывает шаблоны (/api/list) по 7 уровням архитектуры.
// Уровни — те же «слои», что в схеме знаний: фундамент снизу, предметка сверху.
// Уровень определяется по ключевым словам в группе/названии — так ложатся и
// готовые шаблоны, и свои загруженные (с любыми группами).
const LEVELS = [
  { n:1, key:'basics', color:'#B45CFF', name:'Основы языка',
    what:'переменные, условия, циклы, функции, типы — алфавит, без него никуда',
    kw:['основ','управлен','переменн','услови','цикл','синтаксис','справочник','одна задача','ветвлен'] },
  { n:2, key:'data', color:'#3DD9FF', name:'Структуры данных',
    what:'массив, объект/словарь, строки, простая база — ЧЕМ и как хранить',
    kw:['массив','объект','строк','словар','список','структур','данные','база','коллекц'] },
  { n:3, key:'flow', color:'#52F2C9', name:'Поток данных, логика и вывод',
    what:'связывание шагов, события, состояние, расчёты, игры, отрисовка на экран',
    kw:[] },   // сюда попадает всё, что не опознано как другой слой
  { n:4, key:'arch', color:'#FF8800', name:'Архитектура',
    what:'модули и импорты, библиотеки, серверы, стили/вёрстка — кто кого зовёт',
    kw:['библиотек','сервер','файл','модул','импорт','export','стил','css','верстк','роут','маршрут'] },
  { n:5, key:'net', color:'#FF2FAE', name:'Данные и сеть',
    what:'fetch, API, JSON, парсеры, хранилище/localStorage, обход CORS',
    kw:['сеть','запрос','fetch','api','парсер','прокси','cors','хранилищ','storage','localstorage','кэш','gist'] },
  { n:6, key:'debug', color:'#E8895A', name:'Отладка и тесты',
    what:'найти баг, воспроизвести, проверить',
    kw:['отладк','debug','юнит','тест'], link:{ href:'/schema-debug.html', text:'→ практикум по отладке' } },
  { n:7, key:'domain', color:'#9C90C4', name:'Предметка: финансы и математика',
    what:'доходности, риск, корреляции, индикаторы — ЧТО именно считать',
    kw:['риск','портфел','облигац','доходн','ковариац','корреляц','ssa','финанс','индикатор','дисперс','волатил','эмитент'] },
];
const LANG_LABEL = { js:'JS', python:'PY', sql:'SQL', css:'CSS', other:'—' };
// порядок проверки: специфичные слои раньше; «поток» (flow) — как запасной
const ORDER = ['domain','net','arch','debug','data','basics','flow'];
function levelFor(t){
  const hay = ((t.group || '') + ' ' + (t.title || '')).toLowerCase();
  for(const key of ORDER){
    const L = LEVELS.find(x => x.key === key);
    if(L.kw.some(w => hay.includes(w))) return key;
  }
  return 'flow';
}

(async function(){
  let list = [];
  try { list = await fetch('/api/list').then(r => r.json()); } catch(_){
    document.getElementById('sections').innerHTML = '<div class="muted pad">сервер недоступен</div>'; return;
  }
  // разложить по уровням
  const byLevel = {}; LEVELS.forEach(L => byLevel[L.key] = []);
  list.forEach(t => byLevel[levelFor(t)].push(t));

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
      // внутри уровня — по исходным группам (твои темы: Canvas, DOM, Игры…)
      const bg = {}; items.forEach(t => { (bg[t.group || '—'] = bg[t.group || '—'] || []).push(t); });
      const groups = Object.keys(bg).sort((a, b) => bg[b].length - bg[a].length);
      groups.forEach(g => {
        if(groups.length > 1){ const gl = document.createElement('div'); gl.className = 'lsub'; gl.textContent = g + ' · ' + bg[g].length; sec.appendChild(gl); }
        const grid = document.createElement('div'); grid.className = 'cards';
        bg[g].forEach(t => grid.appendChild(card(t)));
        sec.appendChild(grid);
      });
    } else if(L.link){
      const a = document.createElement('a'); a.className = 'lsec-link'; a.href = L.link.href; a.textContent = L.link.text; sec.appendChild(a);
    }
    host.appendChild(sec);
  });
})();

function card(t){
  const a = document.createElement('a'); a.className = 'tcard'; a.href = '/component.html?id=' + encodeURIComponent(t.id);
  a.innerHTML = '<div class="tcard-h"><span class="tcard-t"></span><span class="tcard-l">' + esc(LANG_LABEL[(t.lang||'other').toLowerCase()] || (t.lang||'').toUpperCase()) + '</span></div>'
    + '<div class="tcard-d"></div><div class="tcard-g"></div>';
  a.querySelector('.tcard-t').textContent = t.title || 'без названия';
  a.querySelector('.tcard-d').textContent = t.desc || '';
  a.querySelector('.tcard-g').textContent = t.group || '';
  return a;
}
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
