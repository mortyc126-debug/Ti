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
// какие языки установлены у пользователя (спрашиваем сервер один раз)
let _serverLangs = null;
function serverLangs(){ return _serverLangs || (_serverLangs = fetch('/api/run/langs').then(r => r.json()).catch(() => ({ langs: [], bins: {} }))); }

const $ = s => document.querySelector(s);
const nav = $('#nav'), work = $('#work'), info = $('#info');
let navLang = '';   // фильтр списка по языку (чтобы углубиться в один)
let selected = null;      // выбранный токен-элемент
let curId = null;         // id открытого шаблона
let curTpl = null;        // объект открытого шаблона

// опции языков для форм куска — из единого списка (langs.js); + «другой» и текущий, если он не из списка
function langOptionsHtml(sel){
  const list = (window.CODELAB_LANGS && window.CODELAB_LANGS.length) ? window.CODELAB_LANGS.map(l => [l.v, l.t]) : [['js','JavaScript'],['python','Python'],['sql','SQL']];
  const vals = list.map(x => x[0]);
  let opts = list.map(([v, t]) => `<option value="${v}"${sel === v ? ' selected' : ''}>${esc(t)}</option>`).join('');
  opts += `<option value="other"${sel === 'other' ? ' selected' : ''}>другой</option>`;
  if(sel && !vals.includes(sel) && sel !== 'other') opts = `<option value="${esc(sel)}" selected>${esc(sel)}</option>` + opts;
  return opts;
}

async function loadList(openId){
  let list;
  try { list = await fetch('/api/list').then(r => r.json()); }
  catch(e){ nav.innerHTML = '<div class="muted pad">сервер недоступен</div>'; return; }
  nav.innerHTML = '';
  const add = document.createElement('div'); add.className = 'addbtn'; add.textContent = '+ новый шаблон (вставить код)';
  add.onclick = showAddForm; nav.appendChild(add);
  const imp = document.createElement('div'); imp.className = 'addbtn'; imp.textContent = '⬆ загрузить файлы кода (.js/.py/.sql)';
  imp.onclick = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true;
    inp.accept = '.js,.mjs,.jsx,.ts,.py,.sql,.txt';
    inp.onchange = async e => {
      const fs = [...(e.target.files || [])]; if(!fs.length) return;
      imp.textContent = 'загружаю ' + fs.length + '…'; let ok = 0, last = null;
      for(const f of fs){
        try {
          const text = await f.text();
          const ext = (f.name.split('.').pop() || '').toLowerCase();
          const lang = ({ py: 'python', sql: 'sql' })[ext] || 'js';
          const r = await fetch('/api/add', { method: 'POST', body: JSON.stringify({ title: f.name.replace(/\.[^.]+$/, ''), lang, group: 'Мои куски', code: text, desc: 'из файла ' + f.name }) }).then(r => r.json()).catch(() => ({}));
          if(r.id){ ok++; last = r.id; }
        } catch(_){}
      }
      imp.textContent = '✓ загружено ' + ok + '/' + fs.length;
      setTimeout(() => loadList(last), 700);
    };
    inp.click();
  };
  nav.appendChild(imp);

  // отправить шаблоны на GitHub (чтобы не жили только локально)
  const gh = document.createElement('div'); gh.className = 'addbtn'; gh.style.borderColor = 'rgba(61,217,255,.4)'; gh.style.color = 'var(--name)';
  gh.textContent = 'Сохранить шаблоны на GitHub';
  async function refreshGh(){
    try {
      const i = await fetch('/api/git/info').then(r => r.json());
      if(!i.repo){ gh.textContent = 'GitHub: нет git-репозитория (локально)'; return; }
      gh.textContent = i.dirty ? ('Сохранить на GitHub (не сохранено: ' + i.dirty + ')') : ('На GitHub всё сохранено · ' + i.branch);
    } catch(_){ gh.textContent = 'Сохранить шаблоны на GitHub'; }
  }
  gh.onclick = async () => {
    gh.textContent = 'отправляю на GitHub…';
    const r = await fetch('/api/git/sync', { method: 'POST' }).then(r => r.json()).catch(() => ({ ok: false, message: 'сервер недоступен' }));
    gh.textContent = (r.ok ? '✓ ' : '⚠ ') + (r.message || (r.ok ? 'готово' : 'не удалось'));
    setTimeout(refreshGh, 3500);
  };
  nav.appendChild(gh); refreshGh();

  if(!list.length){ const m = document.createElement('div'); m.className = 'muted pad'; m.textContent = 'Пока пусто. Нажми «+ новый шаблон».'; nav.appendChild(m); return; }
  // фильтр по языкам — чтобы углубиться нормально в один
  const langs = [...new Set(list.map(t => String(t.lang || '').toLowerCase()).filter(Boolean))].sort();
  if(langs.length > 1){
    const bar = document.createElement('div'); bar.className = 'lib-langs';
    const mk = (val, label) => { const c = document.createElement('span'); c.className = 'lib-lang' + (navLang === val ? ' on' : ''); c.textContent = label; c.onclick = () => { navLang = val; loadList(openId); }; return c; };
    bar.appendChild(mk('', 'все'));
    langs.forEach(l => bar.appendChild(mk(l, l.toUpperCase())));
    nav.appendChild(bar);
  }
  const shown = navLang ? list.filter(t => String(t.lang || '').toLowerCase() === navLang) : list;
  if(!shown.length){ const m = document.createElement('div'); m.className = 'muted pad'; m.textContent = 'Нет кусков на языке ' + navLang.toUpperCase() + '.'; nav.appendChild(m); return; }
  const groups = [];
  for(const t of shown){ let g = groups.find(x => x.name === t.group); if(!g){ g = { name: t.group, items: [] }; groups.push(g); } g.items.push(t); }
  const hashId = decodeURIComponent((location.hash || '').replace(/^#/, ''));
  const want = openId || curId || hashId || null;
  // какую группу раскрыть: с нужным шаблоном, иначе первую
  let openGroup = (want && (groups.find(g => g.items.some(t => t.id === want)) || {}).name) || (groups[0] && groups[0].name);
  for(const g of groups){
    const open = g.name === openGroup;
    const h = document.createElement('div'); h.className = 'grp' + (open ? ' open' : '');
    h.innerHTML = `<span class="grp-caret">${open ? '▾' : '▸'}</span><span class="grp-name">${esc(g.name)}</span><span class="grp-n">${g.items.length}</span>`;
    const box = document.createElement('div'); box.className = 'grp-items'; box.style.display = open ? 'block' : 'none';
    h.onclick = () => {
      const now = box.style.display === 'none';
      box.style.display = now ? 'block' : 'none';
      h.querySelector('.grp-caret').textContent = now ? '▾' : '▸';
      h.classList.toggle('open', now);
    };
    nav.appendChild(h);
    for(const t of g.items){
      const d = document.createElement('div'); d.className = 'tpl'; d.dataset.id = t.id;
      d.innerHTML = `<span>${esc(window.codelabTitle ? window.codelabTitle(t.title) : t.title)}</span><span class="lang">${esc((t.lang||'').toUpperCase())}</span>`;
      d.onclick = () => select(t.id, d);
      box.appendChild(d);
    }
    nav.appendChild(box);
  }
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
  if(tpl.desc){ const d = document.createElement('div'); d.className = 't-desc'; d.innerHTML = descFmt(tpl.desc); work.appendChild(d); }

  const bar = document.createElement('div'); bar.className = 'toolbar';
  const copy = mkBtn('⧉ копировать код');
  const reset = mkBtn('↺ сброс имён');
  const edit = mkBtn('✎ править');
  const dsc = mkBtn('✨ описание');
  const del = mkBtn('🗑 удалить'); del.classList.add('danger');
  const webRun = (tpl.lang || '').toLowerCase() === 'js';
  const run = mkBtn(webRun ? '▶ запустить' : '▶ запустить на ПК');
  run.classList.add('ok');
  bar.append(copy, reset, edit, dsc, run, del); work.appendChild(bar);
  edit.onclick = () => showEditForm(tpl);
  // быстро добавить/поправить описание: подсказываем по коду, пользователь правит
  dsc.onclick = async () => {
    const code = (tpl.lines || []).map(line => (line || []).map(t => t.v != null ? t.v : '').join('')).join('\n');
    const suggest = describe(code);
    const cur = (tpl.desc && !/^из файла /.test(tpl.desc)) ? tpl.desc : suggest;
    const v = prompt('Описание куска (что он делает). Подсказка по коду уже вписана — поправь под себя:', cur);
    if(v === null) return;
    const r = await fetch('/api/edit', { method: 'POST', body: JSON.stringify({ id: curId, desc: v }) }).then(r => r.json()).catch(() => ({}));
    if(r.ok){ tpl.desc = v; select(curId, nav.querySelector('.tpl.on')); } else flash(dsc, 'ошибка');
  };

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

  const codeText = () => [...pre.querySelectorAll('.line')].map(l => l.textContent.replace(/​/g, '')).join('\n');
  if(webRun){
    const box = document.createElement('div'); box.className = 'preview';
    const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts';
    box.appendChild(frame); work.appendChild(box);
    run.onclick = () => runCode(frame, codeText());
  } else {
    // запуск на установленном у пользователя языке — через локальный сервер
    const box = document.createElement('div'); box.className = 'out run-out'; box.style.display = 'none';
    box.innerHTML = '<div class="lbl">вывод запуска (на твоём ПК)</div><pre></pre><div class="run-langs muted"></div>';
    const outPre = box.querySelector('pre'); work.appendChild(box);
    serverLangs().then(info => { const note = box.querySelector('.run-langs'); if(note && info && info.langs) note.textContent = 'установлено на этом ПК: ' + (info.langs.length ? info.langs.join(', ') : '— ничего из поддерживаемых не найдено'); });
    run.onclick = async () => {
      box.style.display = ''; outPre.textContent = 'запускаю…'; run.disabled = true;
      const r = await fetch('/api/run', { method: 'POST', body: JSON.stringify({ lang: tpl.lang, code: codeText() }) }).then(x => x.json()).catch(() => ({ ok: false, error: 'сервер недоступен' }));
      run.disabled = false;
      if(!r.ok){ outPre.textContent = '⚠ ' + (r.error || 'ошибка'); return; }
      let t = r.stdout || '';
      if(r.stderr) t += (t ? '\n' : '') + '⚠ ' + r.stderr;
      if(r.timedOut) t += '\n⏱ прервано по таймауту (10 секунд)';
      if(!t.trim()) t = '(код отработал, вывода нет · завершился с кодом ' + r.code + ')';
      outPre.textContent = t;
    };
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
  showPop(span, k);   // всплывашка прямо у слова — чтобы не скроллить к панели
}

// Всплывающее пояснение у самого слова. Один элемент на страницу.
let _pop = null;
function showPop(span, k){
  if(!_pop){ _pop = document.createElement('div'); _pop.className = 'tok-pop'; document.body.appendChild(_pop); }
  const e = span.dataset.e;
  _pop.innerHTML = '';
  const kd = document.createElement('div'); kd.className = 'tp-kind'; kd.textContent = KIND_LABEL[k] || k;
  const bd = document.createElement('div'); bd.className = 'tp-body';
  bd.textContent = e || 'пояснение пока не задано — впиши в панели справа';
  if(!e) bd.classList.add('tp-empty');
  _pop.append(kd, bd);
  _pop.style.display = 'block';
  // позиция: под словом, в пределах экрана
  const r = span.getBoundingClientRect();
  const w = Math.min(320, window.innerWidth - 24);
  _pop.style.width = w + 'px';
  let left = r.left + window.scrollX;
  if(left + w > window.scrollX + window.innerWidth - 12) left = window.scrollX + window.innerWidth - w - 12;
  _pop.style.left = Math.max(window.scrollX + 12, left) + 'px';
  _pop.style.top = (r.bottom + window.scrollY + 6) + 'px';
}
function hidePop(){ if(_pop) _pop.style.display = 'none'; }
document.addEventListener('scroll', hidePop, true);
document.addEventListener('mousedown', ev => { if(_pop && !_pop.contains(ev.target) && !(ev.target.classList && ev.target.classList.contains('tok'))) hidePop(); });

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
      <label>Язык<select id="f-lang">${langOptionsHtml('js')}</select></label>
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
  // CodeMirror (если установлен и включён на странице «Редактор кода»); иначе остаётся обычное поле
  if(window.CMBridge){ CMBridge.enhance($('#f-code'), $('#f-lang').value); $('#f-lang').addEventListener('change', ev => CMBridge.setLang($('#f-code'), ev.target.value)); }

  $('#f-file').onchange = async e => {
    const file = e.target.files && e.target.files[0]; if(!file) return;
    $('#f-code').value = await file.text();
    if(!$('#f-title').value) $('#f-title').value = file.name.replace(/\.[^.]+$/, '');
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const map = { py: 'python', sql: 'sql', js: 'js', mjs: 'js', jsx: 'js', ts: 'js' };
    if(map[ext]) $('#f-lang').value = map[ext];
    if(window.CMBridge) CMBridge.setLang($('#f-code'), $('#f-lang').value);
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

// Правка шаблона: открыть весь код текстом, сохранить → сервер заново
// токенизирует и перезаписывает файл (пояснения к словам при этом сбросятся,
// т.к. код изменился — впишешь заново кликом по слову).
function showEditForm(tpl){
  const code = (tpl.lines || []).map(line => (line || []).map(t => t.v != null ? t.v : '').join('')).join('\n');
  work.innerHTML = '';
  const h = document.createElement('div'); h.className = 't-title'; h.textContent = 'Правка: ' + (tpl.title || '');
  const p = document.createElement('div'); p.className = 't-desc';
  p.textContent = 'Меняй код как хочешь — структуру, слова, строки. После сохранения он заново раскрасится. Пояснения к словам сбросятся (код же поменялся).';
  work.append(h, p);
  const f = document.createElement('div'); f.className = 'form';
  f.innerHTML = `
    <label>Название<input id="e-title"></label>
    <div class="row">
      <label>Язык<select id="e-lang">${langOptionsHtml(tpl.lang || 'js')}</select></label>
      <label>Группа<input id="e-group"></label>
    </div>
    <label>Описание<input id="e-desc"></label>
    <label>Код<textarea id="e-code" rows="16" spellcheck="false"></textarea></label>
    <label>Что на выходе<textarea id="e-out" rows="2"></textarea></label>
    <div class="toolbar"><button class="btn ok" id="e-save">сохранить</button><button class="btn" id="e-cancel">отмена</button></div>
    <div class="muted" id="e-err"></div>`;
  work.appendChild(f);
  $('#e-title').value = tpl.title || ''; $('#e-group').value = tpl.group || '';
  $('#e-desc').value = tpl.desc || ''; $('#e-code').value = code; $('#e-out').value = tpl.output || '';
  if(window.CMBridge){ CMBridge.enhance($('#e-code'), $('#e-lang').value); $('#e-lang').addEventListener('change', ev => CMBridge.setLang($('#e-code'), ev.target.value)); }
  $('#e-cancel').onclick = () => select(curId, nav.querySelector('.tpl.on'));
  $('#e-save').onclick = async () => {
    const body = { id: curId, title: $('#e-title').value, lang: $('#e-lang').value, group: $('#e-group').value, desc: $('#e-desc').value, code: $('#e-code').value, output: $('#e-out').value };
    const r = await fetch('/api/edit', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()).catch(() => ({}));
    if(r.ok){ loadList(curId); } else $('#e-err').textContent = 'ошибка: ' + (r.error || 'не сохранилось');
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
// грубая авто-подсказка описания по коду (без ИИ) — что в куске происходит
function describe(code){
  const t = String(code || ''); const bits = [];
  let m = t.match(/\bfunction\s+([A-Za-zА-Яа-я_$][\wА-Яа-я$]*)/) || t.match(/\b(?:const|let|var)\s+([A-Za-zА-Яа-я_$][\wА-Яа-я$]*)\s*=\s*(?:async\s*)?\(?[^=\n]*=>/);
  if(m) bits.push('функция «' + m[1] + '»');
  m = t.match(/\bclass\s+([A-Za-zА-Яа-я_$][\wА-Яа-я$]*)/); if(m) bits.push('класс «' + m[1] + '»');
  const loops = (t.match(/\b(for|while)\b/g) || []).length; if(loops) bits.push(loops > 1 ? ('циклы ×' + loops) : 'цикл');
  const ifs = (t.match(/\bif\b/g) || []).length; if(ifs) bits.push(ifs > 1 ? ('ветвления ×' + ifs) : 'ветвление if');
  if(/\.(map|reduce|filter|forEach)\(/.test(t)) bits.push('обработка массива (map/reduce/…)');
  if(/\bfetch\(|XMLHttpRequest/.test(t)) bits.push('сетевой запрос');
  if(/addEventListener|onclick/.test(t)) bits.push('обработчик события');
  if(/getContext\(|<svg|createElement|innerHTML/.test(t)) bits.push('рисование/DOM');
  if(/console\.(log|error|warn|info)|\bprint\(/.test(t)) bits.push('вывод');
  let s = bits.length ? bits.join(', ') : 'фрагмент кода';
  const ret = t.match(/\breturn\s+([^;\n]{1,48})/); if(ret) s += '; возвращает ' + ret[1].trim();
  const n = t.split('\n').filter(x => x.trim()).length;
  return s.charAt(0).toUpperCase() + s.slice(1) + '. ~' + n + ' строк.';
}
function mkBtn(t){ const b = document.createElement('button'); b.className = 'btn'; b.textContent = t; return b; }
function flash(btn, t){ const old = btn.textContent; btn.classList.add('ok'); btn.textContent = t; setTimeout(() => { btn.classList.remove('ok'); btn.textContent = old; }, 1200); }
function resetInfo(){ selected = null; info.innerHTML = '<div class="info-empty muted">Нажми на слово в коде — здесь появится, что оно значит, и можно вписать своё пояснение.</div>'; }
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
// описание с кодом: `код` → цветная плашка, ```блок``` → цветной блок
function descFmt(s){
  s = String(s == null ? '' : s);
  const blocks = [];
  s = s.replace(/```([\s\S]*?)```/g, (m, c) => { blocks.push(c.replace(/^\n+|\n+$/g, '')); return '\u0001' + (blocks.length - 1) + '\u0001'; });
  let html = esc(s).replace(/`([^`\n]+)`/g, (m, c) => '<code class="desc-chip">' + c + '</code>').replace(/\n/g, '<br>');
  return html.replace(/\u0001(\d+)\u0001/g, (m, i) => '<pre class="desc-code">' + esc(blocks[+i]) + '</pre>');
}
const cssEsc = s => String(s).replace(/["\\]/g, '\\$&');

// автоподпись слов во всех шаблонах из словаря keyword-dict.json (вручную вписанные пояснения не трогает)
const _annAll = document.getElementById('annAll');
if(_annAll) _annAll.onclick = async () => {
  const o = _annAll.textContent; _annAll.disabled = true; _annAll.textContent = '…';
  let r; try { r = await fetch('/api/annotate-all', { method: 'POST' }).then(x => x.json()); } catch(_){ r = { ok: false }; }
  _annAll.disabled = false;
  if(r && r.ok){ _annAll.textContent = '✓ ' + r.added + ' слов в ' + r.files + ' кусках'; if(curId) loadList(curId); setTimeout(() => { _annAll.textContent = o; }, 2500); }
  else { _annAll.textContent = 'ошибка'; setTimeout(() => { _annAll.textContent = o; }, 2000); }
};

// видимый блок загрузки + образцы форматов (upload-templates.js); обновляем список после загрузки
const _upHost = document.getElementById('uploader');
if(_upHost && window.renderUploader) window.renderUploader(_upHost, { onDone: () => loadList() });

loadList();
