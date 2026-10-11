// Клиент «Лаборатории кода». Рендерит шаблон токен-за-токеном: клик по слову →
// панель справа, где видно что это и можно ВПИСАТЬ пояснение (сохранится в
// файл). Синие «имена» (и строки/числа) правятся прямо в коде; правка имени
// разносится на все такие же. Копирование собирает текущий код. Новый шаблон
// добавляется со страницы — вставил/загрузил код, он раскрасился и сохранился.

const KIND_LABEL = {
  kw: 'ключевое слово', name: 'имя — можно менять', fn: 'функция / метод',
  str: 'строка (текст)', num: 'число', op: 'оператор / символ', com: 'комментарий',
};
const EDITABLE = new Set(['name', 'str', 'num']);

const $ = s => document.querySelector(s);
const nav = $('#nav'), work = $('#work'), info = $('#info');
let selected = null;      // выбранный токен-элемент
let curId = null;         // id открытого шаблона
let curTpl = null;        // объект открытого шаблона

async function loadList(openId){
  let list;
  try { list = await fetch('/api/list').then(r => r.json()); }
  catch(e){ nav.innerHTML = '<div class="muted pad">сервер недоступен</div>'; return; }
  nav.innerHTML = '';
  const add = document.createElement('div'); add.className = 'addbtn'; add.textContent = '+ новый шаблон (вставить код)';
  add.onclick = showAddForm; nav.appendChild(add);
  if(!list.length){ const m = document.createElement('div'); m.className = 'muted pad'; m.textContent = 'Пока пусто. Нажми «+ новый шаблон».'; nav.appendChild(m); return; }
  const groups = [];
  for(const t of list){ let g = groups.find(x => x.name === t.group); if(!g){ g = { name: t.group, items: [] }; groups.push(g); } g.items.push(t); }
  for(const g of groups){
    const h = document.createElement('div'); h.className = 'grp'; h.textContent = g.name; nav.appendChild(h);
    for(const t of g.items){
      const d = document.createElement('div'); d.className = 'tpl'; d.dataset.id = t.id;
      d.innerHTML = `<span>${esc(t.title)}</span><span class="lang">${esc((t.lang||'').toUpperCase())}</span>`;
      d.onclick = () => select(t.id, d);
      nav.appendChild(d);
    }
  }
  const want = openId || curId;
  const target = want && nav.querySelector(`.tpl[data-id="${cssEsc(want)}"]`);
  const first = target || nav.querySelector('.tpl');
  if(first) select(first.dataset.id, first);
}

async function select(id, el){
  nav.querySelectorAll('.tpl').forEach(x => x.classList.toggle('on', x === el));
  work.innerHTML = '<div class="muted pad">загрузка…</div>'; resetInfo();
  let tpl;
  try { tpl = await fetch('/api/template?id=' + encodeURIComponent(id)).then(r => r.json()); }
  catch(e){ work.innerHTML = '<div class="muted pad">ошибка загрузки</div>'; return; }
  curId = id; curTpl = tpl; render(tpl);
}

function render(tpl){
  work.innerHTML = '';
  const title = document.createElement('div'); title.className = 't-title';
  title.innerHTML = `${esc(tpl.title || '')} <span class="t-lang">${esc((tpl.lang||'').toUpperCase())}</span>`;
  work.appendChild(title);
  if(tpl.desc){ const d = document.createElement('div'); d.className = 't-desc'; d.textContent = tpl.desc; work.appendChild(d); }

  const bar = document.createElement('div'); bar.className = 'toolbar';
  const copy = mkBtn('⧉ копировать код');
  const reset = mkBtn('↺ сброс имён');
  const del = mkBtn('🗑 удалить'); del.classList.add('danger');
  const runnable = tpl.lang === 'js';
  const run = runnable ? mkBtn('▶ запустить') : null;
  if(run) run.classList.add('ok');
  bar.append(copy, reset); if(run) bar.append(run); bar.append(del); work.appendChild(bar);

  const pre = document.createElement('pre'); pre.className = 'code mono';
  (tpl.lines || []).forEach((line, li) => {
    const ld = document.createElement('div'); ld.className = 'line';
    (line || []).forEach((tk, ti) => ld.appendChild(makeTok(tk, li, ti)));
    if(!line || !line.length) ld.appendChild(document.createTextNode('\u200b'));
    pre.appendChild(ld);
  });
  work.appendChild(pre);

  if(tpl.output != null && tpl.output !== ''){
    const o = document.createElement('div'); o.className = 'out';
    o.innerHTML = `<div class="lbl">что получится на выходе</div><pre></pre>`;
    o.querySelector('pre').textContent = tpl.output; work.appendChild(o);
  }

  const lg = document.createElement('div'); lg.className = 'legend';
  lg.innerHTML = 'Цвета: <b style="color:var(--kw)">ключевые слова</b> · <b style="color:var(--name)">имена (правятся)</b> · '
    + '<b style="color:var(--fn)">функции</b> · <b style="color:var(--str)">строки</b> · <b style="color:var(--num)">числа</b> · <b style="color:var(--com)">комментарии</b>. '
    + 'Клик по слову → впиши, что оно значит (сохранится).';
  work.appendChild(lg);

  if(run){
    const box = document.createElement('div'); box.className = 'preview';
    const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts';
    box.appendChild(frame); work.appendChild(box);
    run.onclick = () => runCode(frame, [...pre.querySelectorAll('.line')].map(l => l.textContent.replace(/​/g, '')).join('\n'));
  }

  copy.onclick = () => {
    const text = [...pre.querySelectorAll('.line')].map(l => l.textContent.replace(/\u200b/g, '')).join('\n');
    navigator.clipboard.writeText(text).then(() => flash(copy, '✓ скопировано'));
  };
  reset.onclick = () => select(curId, nav.querySelector('.tpl.on'));
  del.onclick = async () => {
    if(!confirm(`Удалить шаблон «${tpl.title}»? Файл будет удалён.`)) return;
    await fetch('/api/delete', { method: 'POST', body: JSON.stringify({ id: curId }) });
    curId = null; curTpl = null; loadList();
  };
}

function makeTok(tk, li, ti){
  const span = document.createElement('span');
  const k = tk.k || 'plain';
  span.className = 'tok k-' + k;
  if(k === 'sp'){ span.textContent = tk.v || ' '; return span; }
  span.textContent = tk.v != null ? tk.v : '';
  span.dataset.line = li; span.dataset.idx = ti; span.dataset.kind = k;
  if(tk.r) span.dataset.ref = tk.r;
  if(tk.e) span.dataset.e = tk.e;
  span.classList.add('clk');   // кликабельны все слова (чтобы можно было вписать пояснение)

  if(EDITABLE.has(k)){
    span.classList.add('editable'); span.contentEditable = 'true'; span.spellcheck = false;
    span.addEventListener('input', () => {
      if(!tk.r) return;
      const val = span.textContent;
      document.querySelectorAll(`.tok[data-ref="${cssEsc(tk.r)}"]`).forEach(o => { if(o !== span) o.textContent = val; });
    });
    span.addEventListener('focus', () => showInfo(span));
    span.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); span.blur(); } });
  }
  span.addEventListener('click', () => showInfo(span));
  return span;
}

function showInfo(span){
  if(selected) selected.classList.remove('sel');
  selected = span; span.classList.add('sel');
  const k = span.dataset.kind;
  const line = Number(span.dataset.line), idx = Number(span.dataset.idx);
  info.innerHTML = '';
  const kind = document.createElement('div'); kind.className = 'info-kind'; kind.textContent = KIND_LABEL[k] || k;
  const word = document.createElement('div'); word.className = 'info-word mono'; word.textContent = span.textContent || '(пусто)';
  info.append(kind, word);

  const lbl = document.createElement('div'); lbl.className = 'info-kind'; lbl.style.marginTop = '12px'; lbl.textContent = 'что это значит';
  const ta = document.createElement('textarea'); ta.className = 'ann'; ta.value = span.dataset.e || '';
  ta.placeholder = 'впиши своими словами, что делает это слово…';
  const saveBtn = mkBtn('сохранить пояснение'); saveBtn.classList.add('full');
  saveBtn.onclick = async () => {
    const r = await fetch('/api/annotate', { method: 'POST', body: JSON.stringify({ id: curId, line, idx, e: ta.value }) }).then(r => r.json()).catch(() => ({}));
    if(r.ok){ span.dataset.e = ta.value; if(curTpl && curTpl.lines[line] && curTpl.lines[line][idx]) curTpl.lines[line][idx].e = ta.value; flash(saveBtn, '✓ сохранено'); }
    else flash(saveBtn, 'ошибка');
  };
  info.append(lbl, ta, saveBtn);

  if(EDITABLE.has(k)){
    const hint = document.createElement('div'); hint.className = 'info-hint';
    hint.textContent = k === 'name'
      ? 'Это имя. Печатай прямо в коде — поменяется во всех местах шаблона.'
      : 'Это значение можно заменить своим прямо в коде.';
    info.append(hint);
  }
}

function showAddForm(){
  nav.querySelectorAll('.tpl').forEach(x => x.classList.remove('on'));
  resetInfo(); curId = null; curTpl = null;
  work.innerHTML = '';
  const h = document.createElement('div'); h.className = 't-title'; h.textContent = 'Новый шаблон';
  const p = document.createElement('div'); p.className = 't-desc';
  p.textContent = 'Вставь код или загрузь файл — он раскрасится и сохранится. Потом кликай по словам и вписывай, что они значат.';
  work.append(h, p);

  const f = document.createElement('div'); f.className = 'form';
  f.innerHTML = `
    <label>Название<input id="f-title" placeholder="например: Цикл по массиву"></label>
    <div class="row">
      <label>Язык<select id="f-lang"><option value="js">JavaScript</option><option value="python">Python</option><option value="sql">SQL</option><option value="other">другой</option></select></label>
      <label>Группа<input id="f-group" placeholder="Мои шаблоны" value="Мои шаблоны"></label>
    </div>
    <label>Описание (необязательно)<input id="f-desc" placeholder="пара слов, зачем этот шаблон"></label>
    <label>Код<textarea id="f-code" rows="12" placeholder="вставь сюда код…" spellcheck="false"></textarea></label>
    <label>Что на выходе (необязательно)<textarea id="f-out" rows="2" placeholder="что печатает / возвращает"></textarea></label>
    <div class="row">
      <input type="file" id="f-file" accept=".js,.py,.sql,.txt,.ts,.jsx,.mjs">
    </div>
    <div class="toolbar"><button class="btn ok" id="f-save">сохранить шаблон</button><button class="btn" id="f-cancel">отмена</button></div>
    <div class="muted" id="f-err"></div>`;
  work.appendChild(f);

  $('#f-file').onchange = async e => {
    const file = e.target.files && e.target.files[0]; if(!file) return;
    $('#f-code').value = await file.text();
    if(!$('#f-title').value) $('#f-title').value = file.name.replace(/\.[^.]+$/, '');
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const map = { py: 'python', sql: 'sql', js: 'js', mjs: 'js', jsx: 'js', ts: 'js' };
    if(map[ext]) $('#f-lang').value = map[ext];
  };
  $('#f-cancel').onclick = () => loadList();
  $('#f-save').onclick = async () => {
    const code = $('#f-code').value;
    if(!code.trim()){ $('#f-err').textContent = 'вставь код'; return; }
    const body = { title: $('#f-title').value || 'Без названия', lang: $('#f-lang').value, group: $('#f-group').value, desc: $('#f-desc').value, code, output: $('#f-out').value };
    const r = await fetch('/api/add', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()).catch(() => ({}));
    if(r.id) loadList(r.id); else $('#f-err').textContent = 'ошибка: ' + (r.error || 'не сохранилось');
  };
}

// запуск JS-шаблона в песочнице-iframe: есть canvas #c и #out для рисунков,
// console.log печатается в превью.
function runCode(frame, code){
  frame.srcdoc = `<!doctype html><meta charset="utf-8"><body style="margin:8px;font:12px ui-monospace,monospace;color:#F6F4FF;background:#0E0720">
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
function mkBtn(t){ const b = document.createElement('button'); b.className = 'btn'; b.textContent = t; return b; }
function flash(btn, t){ const old = btn.textContent; btn.classList.add('ok'); btn.textContent = t; setTimeout(() => { btn.classList.remove('ok'); btn.textContent = old; }, 1200); }
function resetInfo(){ selected = null; info.innerHTML = '<div class="info-empty muted">Нажми на слово в коде — здесь появится, что оно значит, и можно вписать своё пояснение.</div>'; }
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const cssEsc = s => String(s).replace(/["\\]/g, '\\$&');

loadList();
