// Навигатор «С чего начать»: выбираешь цель — получаешь порядок шагов и ссылки
// в нужные разделы Описи. Разделы ищутся по смыслу среди реально существующих,
// поэтому переименования не ломают навигатор.
let TOPGROUPS = [];
(async function(){
  try { const list = await fetch('/api/list').then(r => r.json()); TOPGROUPS = [...new Set(list.map(t => String(t.group || '').split('/')[0].trim()).filter(Boolean))]; } catch(_){ TOPGROUPS = []; }
  renderGoals();
})();

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
// тема → ключевые слова, по которым находим подходящий реальный раздел
const THEMES = {
  basics:  ['основ'],
  ui:      ['интерфейс', 'кнопк', 'форм'],
  data:    ['данн', 'массив'],
  net:     ['сеть', 'запрос', 'api'],
  files:   ['файл', 'сервер', 'хранен'],
  draw:    ['график', 'визуал', 'canvas'],
  games:   ['игр'],
  sql:     ['sql'],
  errors:  ['ошибк', 'отладк'],
  analytics:['математик', 'финанс', 'анализ'],
  css:     ['css'],
  tests:   ['тест']
};
function groupFor(theme){
  const kws = THEMES[theme] || [];
  const hits = TOPGROUPS.filter(g => kws.some(k => g.toLowerCase().includes(k)));
  if(!hits.length) return null;
  // если разделов несколько — берём самый короткий (обычно он же самый чистый по названию)
  return hits.sort((a, b) => a.length - b.length)[0];
}
const invLink = (group, extra) => '/inventory.html?' + (group ? 'group=' + encodeURIComponent(group) + '&' : '') + 'tree=1' + (extra || '');

const GOALS = [
  { key:'site', icon:'', title:'Сайт / страница', lead:'Что-то, что открывается в браузере и на что можно нажимать.',
    steps:[
      ['basics','Основы','Понять переменные, функции, условия — кирпичики любой логики.'],
      ['ui','Интерфейс','HTML — структура (что на экране), CSS — вид (цвета, размеры, кнопки). Начни отсюда: один экран.'],
      ['data','Данные','Что показывать: список, карточки, числа. Как хранить и преобразовывать.'],
      ['net','Сеть','Если данные берутся извне — запрос (fetch) к серверу/API.'],
      ['errors','Ошибки и отладка','Поймать, что ломается, и починить. Нужно почти всегда.']
    ]},
  { key:'bot', icon:'', title:'Бот / автоматизация', lead:'Скрипт, который делает рутину сам: ходит в сеть, обрабатывает, пишет файлы.',
    steps:[
      ['basics','Основы','Переменные, функции, циклы.'],
      ['net','Сеть','Запросы к API/сайтам, разбор ответа.'],
      ['files','Файлы и сервер','Куда складывать результат, как запускать.'],
      ['errors','Ошибки и отладка','Чтобы бот не падал на первой же ошибке.']
    ]},
  { key:'data', icon:'', title:'Обработать данные / аналитика', lead:'Взять таблицу/числа, посчитать, увидеть выводы.',
    steps:[
      ['basics','Основы','База языка.'],
      ['data','Данные','Массивы, объекты, map/filter/reduce, сортировка, фильтры.'],
      ['analytics','Аналитика','Статистика, доходности, риск, корреляции (если про финансы).'],
      ['files','Файлы','Загрузить CSV/Excel, сохранить результат.']
    ]},
  { key:'game', icon:'', title:'Игра / интерактив', lead:'Что-то движется и реагирует на клавиши/мышь.',
    steps:[
      ['basics','Основы','База + понимание «событие → реакция».'],
      ['draw','Графика','Рисование на canvas/SVG, кадры, анимация.'],
      ['ui','Интерфейс','События: клавиатура, мышь, клики.'],
      ['games','Игры','Готовые куски игровой логики (матрица, столкновения).']
    ]},
  { key:'learn', icon:'', title:'Просто учусь с нуля', lead:'Пока без цели — хочу понять, как вообще всё устроено.',
    steps:[
      ['basics','Основы / Синтаксис','Переменная, функция, if, циклы — с этого начинается всё.'],
      ['basics','Основы / Как устроена программа','Как файлы собираются в систему, конвейер «данные → обработка → вывод».']
    ]}
];

function renderGoals(){
  const host = document.getElementById('goals'); if(!host) return;
  host.innerHTML = GOALS.map(g =>
    '<button class="goal" data-key="' + g.key + '"><span class="g-ic">' + g.icon + '</span>'
    + '<span class="g-t">' + esc(g.title) + '</span><span class="g-l">' + esc(g.lead) + '</span></button>'
  ).join('');
  host.querySelectorAll('.goal').forEach(b => b.onclick = () => showGoal(b.dataset.key));
}
function showGoal(key){
  const g = GOALS.find(x => x.key === key); if(!g) return;
  document.querySelectorAll('.goal').forEach(b => b.classList.toggle('on', b.dataset.key === key));
  const host = document.getElementById('steps');
  const rows = g.steps.map((s, i) => {
    const [theme, label, why] = s;
    const grp = groupFor(theme);
    const link = grp ? invLink(grp) : '/inventory.html';
    const missing = grp ? '' : ' <span class="muted">(раздел ещё не заведён)</span>';
    return '<a class="step" href="' + link + '"><span class="s-n">' + (i + 1) + '</span>'
      + '<span class="s-body"><span class="s-t">' + esc(label) + (grp && grp !== label ? ' <span class="s-g">→ ' + esc(grp) + '</span>' : '') + missing + '</span>'
      + '<span class="s-why">' + esc(why) + '</span></span><span class="s-arr">→</span></a>';
  }).join('');
  host.innerHTML = '<div class="steps-h"><b>' + esc(g.icon + ' ' + g.title) + '</b> — порядок шагов. Жми шаг → откроется нужный раздел в Описи.</div>' + rows
    + '<div class="steps-tip">Совет: не делай всё сразу. Сделай один маленький работающий кусок (например, одну кнопку), потом следующий. Полный план — кусок «С чего начать проект» в разделе «Основы».</div>';
  host.scrollIntoView({ behavior:'smooth', block:'start' });
}
