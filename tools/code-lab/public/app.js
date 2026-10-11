// Клиент «Лаборатории кода». Рендерит шаблон токен-за-токеном: клик по слову →
// пояснение справа; синие «имена» (и строки/числа) редактируются прямо в коде,
// правка имени разносится на все такие же в шаблоне. Копирование собирает код
// из текущего (уже отредактированного) состояния.

const KIND_LABEL = {
  kw: 'ключевое слово', name: 'имя — можно менять', fn: 'функция / метод',
  str: 'строка (текст)', num: 'число', op: 'оператор / символ', com: 'комментарий',
};
const EDITABLE = new Set(['name', 'str', 'num']);

const $ = s => document.querySelector(s);
const nav = $('#nav'), work = $('#work'), info = $('#info');
let selected = null;   // выбранный токен-элемент

async function loadList(){
  let list;
  try { list = await fetch('/api/list').then(r => r.json()); }
  catch(e){ nav.innerHTML = '<div class="muted">сервер недоступен</div>'; return; }
  if(!list.length){ nav.innerHTML = '<div class="muted pad">Нет шаблонов. Положи .json в templates/.</div>'; return; }
  // группируем по group, сохраняя порядок появления
  const groups = [];
  for(const t of list){ let g = groups.find(x => x.name === t.group); if(!g){ g = { name: t.group, items: [] }; groups.push(g); } g.items.push(t); }
  nav.innerHTML = '';
  for(const g of groups){
    const h = document.createElement('div'); h.className = 'grp'; h.textContent = g.name; nav.appendChild(h);
    for(const t of g.items){
      const d = document.createElement('div'); d.className = 'tpl'; d.dataset.id = t.id;
      d.innerHTML = `<span>${esc(t.title)}</span><span class="lang">${esc((t.lang||'').toUpperCase())}</span>`;
      d.onclick = () => select(t.id, d);
      nav.appendChild(d);
    }
  }
  // открыть первый по умолчанию
  const first = nav.querySelector('.tpl');
  if(first) select(first.dataset.id, first);
}

async function select(id, el){
  nav.querySelectorAll('.tpl').forEach(x => x.classList.toggle('on', x === el));
  work.innerHTML = '<div class="muted pad">загрузка…</div>';
  resetInfo();
  let tpl;
  try { tpl = await fetch('/api/template?id=' + encodeURIComponent(id)).then(r => r.json()); }
  catch(e){ work.innerHTML = '<div class="muted pad">ошибка загрузки</div>'; return; }
  render(tpl);
}

function render(tpl){
  work.innerHTML = '';
  const title = document.createElement('div'); title.className = 't-title';
  title.innerHTML = `${esc(tpl.title || '')} <span class="t-lang">${esc((tpl.lang||'').toUpperCase())}</span>`;
  work.appendChild(title);
  if(tpl.desc){ const d = document.createElement('div'); d.className = 't-desc'; d.textContent = tpl.desc; work.appendChild(d); }

  const bar = document.createElement('div'); bar.className = 'toolbar';
  const copy = document.createElement('button'); copy.className = 'btn'; copy.textContent = '⧉ копировать код';
  const reset = document.createElement('button'); reset.className = 'btn'; reset.textContent = '↺ сброс имён';
  bar.appendChild(copy); bar.appendChild(reset); work.appendChild(bar);

  const pre = document.createElement('pre'); pre.className = 'code mono';
  (tpl.lines || []).forEach(line => {
    const ld = document.createElement('div'); ld.className = 'line';
    (line || []).forEach(tk => ld.appendChild(makeTok(tk)));
    if(!line || !line.length) ld.appendChild(document.createTextNode('\u200b')); // пустая строка — высота
    pre.appendChild(ld);
  });
  work.appendChild(pre);

  if(tpl.output != null){
    const o = document.createElement('div'); o.className = 'out';
    o.innerHTML = `<div class="lbl">что получится на выходе</div><pre></pre>`;
    o.querySelector('pre').textContent = tpl.output;
    work.appendChild(o);
  }

  const lg = document.createElement('div'); lg.className = 'legend';
  lg.innerHTML = 'Цвета: <b style="color:var(--kw)">ключевые слова</b> · <b style="color:var(--name)">имена (правятся)</b> · '
    + '<b style="color:var(--fn)">функции</b> · <b style="color:var(--str)">строки</b> · <b style="color:var(--num)">числа</b> · <b style="color:var(--com)">комментарии</b>';
  work.appendChild(lg);

  copy.onclick = () => {
    const text = [...pre.querySelectorAll('.line')].map(l => l.textContent.replace(/\u200b/g, '')).join('\n');
    navigator.clipboard.writeText(text).then(() => { copy.classList.add('ok'); copy.textContent = '✓ скопировано'; setTimeout(() => { copy.classList.remove('ok'); copy.textContent = '⧉ копировать код'; }, 1200); });
  };
  reset.onclick = () => render(tpl);   // перерисовать из исходника
}

function makeTok(tk){
  const span = document.createElement('span');
  const k = tk.k || 'plain';
  span.className = 'tok k-' + k;
  if(k === 'sp'){ span.textContent = tk.v || ' '; return span; }  // пробелы/отступы — не кликабельны
  span.textContent = tk.v != null ? tk.v : '';
  if(tk.r) span.dataset.ref = tk.r;
  if(tk.e){ span.dataset.e = tk.e; span.classList.add('clk'); }

  if(EDITABLE.has(k)){
    span.classList.add('editable');
    span.contentEditable = 'true';
    span.spellcheck = false;
    // правка имени разносится на все токены с тем же ref (кроме себя — чтобы не прыгал курсор)
    span.addEventListener('input', () => {
      if(!tk.r) return;
      const val = span.textContent;
      document.querySelectorAll(`.tok[data-ref="${cssEsc(tk.r)}"]`).forEach(o => { if(o !== span) o.textContent = val; });
    });
    span.addEventListener('focus', () => showInfo(span, k));
    span.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); span.blur(); } });
  }
  if(tk.e){
    span.addEventListener('click', () => showInfo(span, k));
  }
  return span;
}

function showInfo(span, k){
  if(selected) selected.classList.remove('sel');
  selected = span; span.classList.add('sel');
  info.innerHTML = '';
  const kind = document.createElement('div'); kind.className = 'info-kind'; kind.textContent = KIND_LABEL[k] || k;
  const word = document.createElement('div'); word.className = 'info-word mono'; word.textContent = span.textContent || '(пусто)';
  const text = document.createElement('div'); text.className = 'info-text'; text.textContent = span.dataset.e || '';
  info.appendChild(kind); info.appendChild(word); info.appendChild(text);
  if(EDITABLE.has(k)){
    const hint = document.createElement('div'); hint.className = 'info-hint';
    hint.textContent = k === 'name'
      ? 'Это имя ты придумываешь сам. Печатай прямо в коде — поменяется во всех местах шаблона.'
      : 'Это значение можно заменить своим прямо в коде.';
    info.appendChild(hint);
  }
}

function resetInfo(){ selected = null; info.innerHTML = '<div class="info-empty muted">Нажми на слово в коде — здесь появится, что оно значит.</div>'; }

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const cssEsc = s => String(s).replace(/["\\]/g, '\\$&');

loadList();
