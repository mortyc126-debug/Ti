// Страница «Задачи»: список, проход по дереву (TaskWalk), правка текстом с живым предпросмотром,
// загрузка пачкой и готовый промпт для ИИ. Формат текста — tasks-format.js, хранение — /api/tasks/*.
(function(){
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const $ = s => document.querySelector(s);
  const main = $('#tkMain'), listEl = $('#tkList');
  const api = (u, b) => fetch(u, b === undefined ? undefined : { method: 'POST', body: JSON.stringify(b) }).then(r => r.json());
  const pref = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch(_){ return d; } };
  const setPref = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch(_){} };
  let LIST = [], CUR = null;

  const FORMAT_HELP = [
    '=== Название задачи | язык | Раздел / Подраздел',
    '> описание: что получится и зачем (можно несколько строк)',
    '~ синонимы через запятую: как ещё можно назвать эту задачу',
    '? Вопрос-развилка',
    '| подсказка к вопросу простыми словами (необязательно)',
    '  - вариант -> кусок: точное название куска из библиотеки',
    '    | зачем этот вариант, когда его выбрать',
    '  - вариант -> задача: название другой задачи',
    '  - вариант -> код',
    '    ```js',
    '    // свой код варианта — живёт внутри задачи',
    '    ```',
    '  - не нужно -> пропустить',
    '  - вариант со своими вопросами',
    '    ? вложенный вопрос (только для этого варианта)',
    '      - ...',
    '! Шаг без выбора -> кусок: название'
  ].join('\n');

  // ── список ──
  async function reload(selectId){
    LIST = await api('/api/tasks/list').catch(() => []);
    renderList();
    const want = selectId || new URLSearchParams(location.search).get('id');
    if(want && LIST.find(t => t.id === want)) showTask(want);
    else if(new URLSearchParams(location.search).has('new')) editTask(null);
    else if(!CUR) renderIntro();
  }
  const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е');
  // язык списка: «все» или один; запоминается
  let LANG = ''; try { LANG = localStorage.getItem('codelab_tasks_lang') || ''; } catch(_){}
  function renderLangs(){
    const box = $('#tkLangs'); const cnt = new Map();
    LIST.forEach(t => cnt.set(t.lang || '', (cnt.get(t.lang || '') || 0) + 1));
    if(LANG && !cnt.has(LANG)) LANG = '';
    const chip = (v, label, n) => '<button class="tk-lang' + (LANG === v ? ' on' : '') + '" data-l="' + esc(v) + '">' + esc(label) + ' <span>' + n + '</span></button>';
    box.innerHTML = cnt.size < 2 && !LANG ? '' : chip('', 'все', LIST.length)
      + [...cnt.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => chip(l, l ? l.toUpperCase() : '?', n)).join('');
    box.querySelectorAll('.tk-lang').forEach(b => b.onclick = () => { LANG = b.dataset.l; try { localStorage.setItem('codelab_tasks_lang', LANG); } catch(_){} renderList(); });
  }
  function renderList(){
    renderLangs();
    const q = norm($('#tkQ').value).split(/\s+/).filter(Boolean);
    const hits = LIST.filter(t => (!LANG || (t.lang || '') === LANG) && (h => q.every(w => h.includes(w)))(norm([t.title, t.group, t.desc, (t.aliases || []).join(' '), t.lang].join(' '))));
    listEl.innerHTML = '';
    if(!LIST.length){ listEl.innerHTML = '<div class="tk-lead">Задач пока нет.</div>'; return; }
    if(!hits.length){ listEl.innerHTML = '<div class="tk-lead">Ничего не нашлось. Можно создать: «＋ новая».</div>'; return; }
    // при «все» заголовок группы — язык · раздел, иначе только раздел
    const groups = new Map();
    hits.sort((a, b) => a.title.localeCompare(b.title, 'ru')).forEach(t => { const sec = (t.group || 'Без раздела').split('/')[0].trim();
      const g = LANG ? sec : (t.lang || '?').toUpperCase() + ' · ' + sec; if(!groups.has(g)) groups.set(g, []); groups.get(g).push(t); });
    [...groups.keys()].sort((a, b) => a.localeCompare(b, 'ru')).forEach(g => {
      const h = document.createElement('div'); h.className = 'tk-g'; h.textContent = g; listEl.appendChild(h);
      groups.get(g).forEach(t => {
        const a = document.createElement('a'); a.className = 'tk-it' + (CUR === t.id ? ' on' : '');
        const sub = (t.group || '').split('/').slice(1).join('/').trim();
        a.innerHTML = '<div class="t">' + esc(t.title) + '</div><div class="m">' + (sub ? esc(sub) + ' · ' : '') + 'вопросов ' + t.steps + ' · вариантов ' + t.options
          + (t.unresolved ? ' · <span class="bad">' + t.unresolved + ' не найдено</span>' : '') + '</div>';
        a.onclick = () => showTask(t.id);
        listEl.appendChild(a);
      });
    });
  }
  $('#tkQ').oninput = renderList;

  function renderIntro(){
    CUR = null; renderList();
    main.innerHTML = '<div class="tk-empty"><h2 style="margin:0 0 8px;font-size:18px">Как это устроено</h2>'
      + '<p><b>Задача</b> — «что хочу сделать». Внутри вопросы-развилки: «как найти кнопку?», «что делать при клике?». '
      + 'У каждого вопроса варианты, и каждый ведёт к <b>куску</b> из библиотеки, к другой <b>задаче</b> или к своему <b>коду</b>. '
      + 'Выбираешь варианты, и справа собирается готовый код.</p>'
      + '<p>Задачи пишутся текстом, поэтому их удобно и править руками, и получать от ИИ. '
      + 'Нажми «⧉ промпт для ИИ», отдай запрос любому чату, а ответ вставь в «пачкой». Код вариантов живёт внутри задачи и библиотеку не засоряет.</p>'
      + '<div class="tk-help"><pre>' + esc(FORMAT_HELP) + '</pre></div></div>';
  }

  // ── проход по задаче ──
  async function showTask(id){
    const t = await api('/api/tasks/get?id=' + encodeURIComponent(id)).catch(() => null);
    if(!t || t.error){ renderIntro(); return; }
    CUR = id; renderList();
    history.replaceState(null, '', '/tasks.html?id=' + encodeURIComponent(id));
    const stepMode = pref('codelab_tasks_step', true), simple = pref('codelab_tasks_simple', true);
    main.innerHTML = '<div class="tk-head"><h2>' + esc(t.title) + '</h2>'
      + '<button class="btn" id="twEdit">✎ править</button><button class="btn danger" id="twDel">удалить</button></div>'
      + (t.desc ? '<div class="tk-desc">' + esc(t.desc) + '</div>' : '')
      + '<div class="tk-meta">' + esc((t.lang || '').toUpperCase()) + (t.group ? ' · ' + esc(t.group) : '') + ((t.aliases || []).length ? ' · ' + esc(t.aliases.join(', ')) : '') + '</div>'
      + '<div class="tk-row"><span class="tk-seg"><button data-m="step">по шагу</button><button data-m="all">всё сразу</button></span>'
      + '<span class="tk-seg"><button data-s="1">подробно</button><button data-s="0">кратко</button></span>'
      + '<button class="btn" id="twReset">↺ сначала</button></div>'
      + '<div class="tk-split"><div class="tk-col"><h3>Вопросы</h3><div id="twWalk"></div></div>'
      + '<div class="tk-col"><h3>Собранный код</h3><div id="twAsm"><div class="tk-lead">Выбери варианты слева, и здесь появится код.</div></div>'
      + '<div class="tk-need" id="twNeed"></div></div></div>';
    const segs = () => { main.querySelectorAll('[data-m]').forEach(b => b.classList.toggle('on', (b.dataset.m === 'step') === stepNow));
      main.querySelectorAll('[data-s]').forEach(b => b.classList.toggle('on', (b.dataset.s === '1') === simpleNow)); };
    let stepNow = stepMode, simpleNow = simple; segs();
    let lastAsm = [];
    const walk = TaskWalk.mount($('#twWalk'), t, { stepMode, simple, onChange: asm => { lastAsm = asm; drawAsm(asm); } });
    main.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { stepNow = b.dataset.m === 'step'; setPref('codelab_tasks_step', stepNow); segs(); walk.setMode({ stepMode: stepNow }); });
    main.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { simpleNow = b.dataset.s === '1'; setPref('codelab_tasks_simple', simpleNow); segs(); walk.setMode({ simple: simpleNow }); });
    $('#twReset').onclick = () => walk.reset();
    $('#twEdit').onclick = () => editTask(id);
    $('#twDel').onclick = async () => { if(!confirm('Удалить задачу «' + t.title + '»? Куски в библиотеке останутся.')) return; await api('/api/tasks/delete', { id }); CUR = null; history.replaceState(null, '', '/tasks.html'); reload(); };

    function drawAsm(asm){
      const box = $('#twAsm'); const parts = TaskWalk.joinAssembly(asm);
      $('#twNeed').innerHTML = '';
      if(!parts.length){ box.innerHTML = '<div class="tk-lead">Выбери варианты слева, и здесь появится код.</div>'; return; }
      box.innerHTML = '';
      parts.forEach(p => {
        const l = document.createElement('div'); l.className = 'tk-asm-l'; l.innerHTML = '<span>' + esc(p.lang.toUpperCase()) + ' · ' + p.list.length + ' кус.</span>';
        const cp = document.createElement('button'); cp.className = 'btn'; cp.textContent = '⧉'; cp.title = 'скопировать'; cp.onclick = () => copy(p.code, cp); l.appendChild(cp);
        const pre = document.createElement('pre'); pre.className = 'tk-pre'; pre.textContent = p.code;
        box.appendChild(l); box.appendChild(pre);
      });
      const row = document.createElement('div'); row.className = 'tk-row';
      row.innerHTML = '<button class="btn ok" id="twOpen" title="открыть собранный код в песочнице Конструктора">в песочницу</button><button class="btn" id="twCheck" title="каких имён коду не хватает и какие куски их дают">чего не хватает?</button>';
      box.appendChild(row);
      $('#twOpen').onclick = () => {
        const ext = { js: 'js', ts: 'ts', html: 'html', css: 'css', python: 'py', sql: 'sql' };
        const files = parts.map(p => ({ name: slugName(t.title) + '.' + (ext[p.lang] || 'txt'), lang: p.lang, code: p.code }));
        try { localStorage.setItem('codelab_open_pending', JSON.stringify(files)); localStorage.setItem('codelab_mode', 'sandbox'); } catch(_){}
        location.href = '/constructor.html';
      };
      $('#twCheck').onclick = () => checkNeeds(parts.map(p => ({ name: p.lang, lang: p.lang, code: p.code })), $('#twNeed'));
    }
  }
  const slugName = s => String(s || 'задача').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'задача';
  function copy(text, btn){ const done = () => { const o = btn.textContent; btn.textContent = '✓'; setTimeout(() => btn.textContent = o, 900); };
    if(navigator.clipboard) navigator.clipboard.writeText(text).then(done, done); else done(); }

  // «чего не хватает»: имена без источника + куски/задачи, которые их дают
  async function checkNeeds(files, host){
    host.innerHTML = '<div class="tk-lead">проверяю…</div>';
    const r = await api('/api/code/next', { files }).catch(() => null);
    if(!r){ host.innerHTML = '<div class="tk-msg err">сервер не ответил</div>'; return; }
    const list = r.unmet.filter(u => !u.generic);
    if(!list.length){ host.innerHTML = '<div class="tk-msg ok">✓ Все имена, которые использует код, где-то заданы.</div>'; return; }
    host.innerHTML = '<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text3);margin:4px 0">Коду не хватает</h3>';
    list.forEach(u => {
      const d = document.createElement('div'); d.className = 'tk-need-it';
      d.innerHTML = '<b>' + esc(u.name) + '</b> <span class="s">' + esc(window.CodeCheck ? CodeCheck.needText(u.name) : 'используется, но нигде не задано') + '</span><div style="margin-top:4px">'
        + (u.tasks.length ? u.tasks.map(t => '<a href="/tasks.html?id=' + encodeURIComponent(t.id) + '">' + esc(t.title) + '</a>').join('') : '')
        + (u.pieces.length ? u.pieces.map(p => '<a href="/component.html?id=' + encodeURIComponent(p.id) + '" title="' + (p.needs.length ? 'сам требует: ' + esc(p.needs.join(', ')) : '') + '">▸ ' + esc(p.title) + '</a>').join('') : '')
        + (!u.tasks.length && !u.pieces.length ? '<span class="s">готового куска для этого в библиотеке нет</span>' : '') + '</div>';
      host.appendChild(d);
    });
  }

  // ── ненайденные ссылки: кандидаты по клику ──
  // Заменяем ссылку только в блоке своей задачи и только по выбору человека; прежнее название — в заметку «было».
  function applyCandidate(text, taskTitle, u, cand){
    const lines = text.split('\n');
    let from = 0, to = lines.length;
    if(taskTitle){
      const hs = lines.map((l, i) => /^\s*={3,}/.test(l) ? i : -1).filter(i => i >= 0);
      const h = hs.find(i => lines[i].replace(/^\s*=+\s*/, '').split('|')[0].trim() === taskTitle);
      if(h != null){ from = h; const nx = hs.find(i => i > h); to = nx == null ? lines.length : nx; }
    }
    const re = /^(.*(?:->|→|=>)\s*)(кусок|piece|задача|task)(\s*:?\s*)(.*?)\s*$/i;
    for(let i = from; i < to; i++){
      const m = lines[i].match(re); if(!m || m[4].trim() !== String(u.ref).trim()) continue;
      const ind = (lines[i].match(/^\s*/) || [''])[0];
      // кандидат может быть другого вида: ИИ написал «кусок:» с названием задачи — тогда и слово меняем
      lines[i] = m[1] + (cand.kind === 'task' ? 'задача' : 'кусок') + ': ' + cand.title;
      lines.splice(i + 1, 0, ind + '    | было: ' + u.ref);
      return lines.join('\n');
    }
    return null;
  }
  // список ненайденного; onPick(u, cand) — выбор кандидата
  function unresolvedHtml(list, tag){
    return list.map((u, i) => '<div class="tk-un" data-k="' + tag + ':' + i + '">не найден' + (u.kind === 'task' ? 'а задача' : ' кусок') + ' «' + esc(u.ref) + '»'
      + (u.label ? ' <span style="opacity:.7">(вариант «' + esc(u.label) + '»)</span>' : '')
      + ((u.candidates || []).length
        ? '<div class="tk-cands">похоже: ' + u.candidates.map((c, j) => '<button class="btn tk-cand" data-c="' + j + '" title="заменить ссылку; прежнее название останется заметкой «было»">' + (c.kind === 'task' ? 'задача: ' : '') + esc(c.title) + (c.lang ? ' <span style="opacity:.6">' + esc(c.lang) + '</span>' : '') + '</button>').join('')
          + '<button class="btn tk-keep" title="ничего не менять">оставить</button></div>'
        : '<div class="tk-cands" style="opacity:.75">похожих нет — останется как есть, подхватится, когда появится с таким названием</div>')
      + '</div>').join('');
  }
  function bindUnresolved(host, lists, onPick){
    host.querySelectorAll('.tk-un').forEach(el => {
      const [tag, i] = el.dataset.k.split(':'); const u = lists[tag][+i];
      el.querySelectorAll('.tk-cand').forEach(b => b.onclick = () => onPick(tag, u, u.candidates[+b.dataset.c]));
      const k = el.querySelector('.tk-keep'); if(k) k.onclick = () => el.remove();
    });
  }

  // раздел задачи должен быть из общего дерева — иначе задача потеряется в списках и промптах
  let TREE = null;
  async function sectionWarn(group){
    if(!TREE) TREE = (await api('/api/sections').catch(() => ({ tree: [] }))).tree || [];
    if(!TREE.length) return '';
    const k = x => String(x || '').trim().toLowerCase().replace(/ё/g, 'е');
    const [top, ...rest] = String(group || '').split('/').map(x => x.trim()).filter(Boolean); const sub = rest.join(' / ');
    const t = TREE.find(x => k(x.name) === k(top));
    if(!top) return 'Раздел не указан. Разделы: ' + TREE.map(x => x.name).join(', ');
    if(!t) return 'Раздела «' + top + '» нет в дереве. Есть: ' + TREE.map(x => x.name).join(', ');
    if(sub && !(t.subs || []).some(x => k(x) === k(sub))) return 'Подраздела «' + sub + '» нет в «' + t.name + '». Есть: ' + (t.subs || []).join(', ');
    return '';
  }

  // ── правка текстом ──
  const NEW_TEXT = '=== Новая задача | js | Раздел\n> что получится в итоге\n~ как ещё это называют\n? Первый вопрос\n  - вариант -> кусок: \n  - не нужно -> пропустить\n';
  async function editTask(id){
    let text = NEW_TEXT;
    if(id){ const t = await api('/api/tasks/get?id=' + encodeURIComponent(id) + '&text=1').catch(() => null); if(t && t.text) text = t.text; }
    CUR = id; renderList();
    main.innerHTML = '<div class="tk-head"><h2>' + (id ? 'Правка задачи' : 'Новая задача') + '</h2>'
      + '<button class="btn ok" id="teSave">сохранить</button>' + (id ? '<button class="btn" id="teBack">к проходу</button>' : '') + '</div>'
      + '<div class="tk-ed"><div>'
      + '<div class="tk-row tk-pick"><input class="tk-q" id="tePick" placeholder="найти кусок или задачу и вставить ссылку в место курсора…"><div class="tk-pick-res" id="tePickRes"></div></div>'
      + '<textarea class="tk-ta" id="teText" spellcheck="false"></textarea>'
      + '<div class="tk-msg" id="teMsg"></div>'
      + '<div class="tk-help"><details><summary>шпаргалка формата</summary><pre>' + esc(FORMAT_HELP) + '</pre>'
      + 'Отступы показывают вложенность: вопрос под вариантом задаётся только тем, кто выбрал этот вариант. Ссылка «кусок:» ищется по точному названию (можно <code>id:…</code>). Код варианта хранится в самой задаче.</details></div>'
      + '</div><div><h3 style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text3);margin:0 0 8px">Как это будет выглядеть</h3><div id="tePrev"></div></div></div>';
    const ta = $('#teText'); ta.value = text;
    if(id) $('#teBack').onclick = () => showTask(id);
    // Tab вставляет отступ, а не уводит фокус: вложенность здесь — смысл
    ta.addEventListener('keydown', e => { if(e.key === 'Tab'){ e.preventDefault(); const p = ta.selectionStart; ta.setRangeText('  ', p, ta.selectionEnd, 'end'); schedule(); } });
    let timer = null, seq = 0;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(preview, 500); };
    ta.addEventListener('input', schedule);
    async function preview(){
      const my = ++seq; const msg = $('#teMsg');
      const r = await api('/api/tasks/import', { text: ta.value, dry: true }).catch(() => null);
      if(my !== seq) return;
      if(!r || !r.tasks || !r.tasks.length){ msg.className = 'tk-msg err'; msg.textContent = 'Нет строки «=== Название | язык | раздел».'; $('#tePrev').innerHTML = ''; return; }
      const x = r.tasks[0];
      const probs = [];
      const sw = await sectionWarn(x.task.group); if(my !== seq) return; if(sw) probs.push(sw);
      if(r.tasks.length > 1) probs.push('В тексте ' + r.tasks.length + ' задачи — сохранится только первая. Для нескольких — «пачкой».');
      (r.warnings || []).forEach(w => probs.push('• ' + w));
      const un = x.report.unresolved;
      msg.className = 'tk-msg' + (probs.length || un.length ? ' err' : ' ok');
      msg.innerHTML = probs.length || un.length ? unresolvedHtml(un, '0') + probs.map(esc).join('<br>') : '✓ Вопросов ' + x.stats.steps + ', вариантов ' + x.stats.options + '. Все ссылки найдены.';
      bindUnresolved(msg, { 0: un }, (tag, u, c) => { const nt = applyCandidate(ta.value, null, u, c); if(nt != null){ ta.value = nt; schedule(); } });
      const host = $('#tePrev'); host.innerHTML = '';
      const w = document.createElement('div'); host.appendChild(w);
      TaskWalk.mount(w, x.task, { stepMode: false, simple: true });
    }
    preview();
    $('#teSave').onclick = async () => {
      const btn = $('#teSave'); if(btn.disabled) return; btn.disabled = true;
      const r = await api('/api/tasks/save', { text: ta.value, id: id || undefined }).catch(() => null);
      btn.disabled = false;
      const msg = $('#teMsg');
      if(!r || !r.ok){ msg.className = 'tk-msg err'; msg.textContent = (r && r.error) || 'не сохранилось'; return; }
      await reload(r.id);
    };
    // поиск куска/задачи → вставка «-> кусок: Название»
    let ps = 0, pt = null;
    const pick = $('#tePick'), res = $('#tePickRes');
    pick.oninput = () => { clearTimeout(pt); pt = setTimeout(async () => {
      const v = pick.value.trim(); const my = ++ps;
      if(v.length < 2){ res.classList.remove('on'); return; }
      const [s, rows] = await Promise.all([api('/api/search?q=' + encodeURIComponent(v) + '&limit=10').catch(() => ({ hits: [] })), TaskWalk.rows()]);
      if(my !== ps) return;
      const items = [];
      LIST.filter(t => norm(t.title).includes(norm(v))).slice(0, 4).forEach(t => items.push({ k: 'задача', title: t.title, ins: ' -> задача: ' + t.title }));
      (s.hits || []).forEach(h => { const r = rows.get(h.id); if(r) items.push({ k: (r.lang || '').toUpperCase(), title: r.title, sub: r.desc, ins: ' -> кусок: ' + r.title }); });
      res.innerHTML = ''; items.forEach(it => {
        const d = document.createElement('div'); d.className = 'tk-pick-it';
        d.innerHTML = '<span class="k">' + esc(it.k) + '</span><span>' + esc(it.title) + (it.sub ? '<br><span style="color:var(--text3);font-size:11px">' + esc(String(it.sub).slice(0, 120)) + '</span>' : '') + '</span>';
        d.onmousedown = e => { e.preventDefault(); insertRef(it.ins); res.classList.remove('on'); pick.value = ''; };
        res.appendChild(d);
      });
      res.classList.toggle('on', items.length > 0);
    }, 200); };
    pick.onblur = () => setTimeout(() => res.classList.remove('on'), 150);
    // если курсор на строке варианта без цели — дописываем ссылку в конец строки, иначе вставляем новую строку-вариант
    function insertRef(ins){
      const v = ta.value, p = ta.selectionStart;
      const ls = v.lastIndexOf('\n', p - 1) + 1; let le = v.indexOf('\n', p); if(le < 0) le = v.length;
      const line = v.slice(ls, le);
      if(/^\s*[-*•!]\s+/.test(line)){
        const base = line.replace(/\s*(?:->|→|=>).*$/, '').replace(/\s+$/, '');
        ta.setRangeText(base + ins, ls, le, 'end');
      } else {
        const ind = (line.match(/^\s*/) || [''])[0];
        const label = ins.replace(/^ -> (кусок|задача): /, '');
        ta.setRangeText((line.trim() ? '\n' : '') + ind + '  - ' + label + ins, le, le, 'end');
      }
      ta.focus(); schedule();
    }
  }

  // ── пачкой ──
  function modal(html){
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    const box = document.createElement('div'); box.className = 'modal'; box.innerHTML = html;
    bg.appendChild(box); document.body.appendChild(bg);
    bg.onclick = e => { if(e.target === bg) bg.remove(); };
    return { bg, box, q: s => box.querySelector(s), close: () => bg.remove() };
  }
  $('#tkBulk').onclick = () => {
    const m = modal('<h3>Задачи пачкой</h3>'
      + '<div class="tk-help">Вставь текст с одной или несколькими задачами (каждая начинается с <code>=== Название | язык | раздел</code>). Одноимённые задачи обновятся, новые создадутся. Сначала «проверить», потом «сохранить».</div>'
      + '<div class="mfield"><textarea id="bkT" rows="16" spellcheck="false" placeholder="=== …"></textarea></div>'
      + '<div class="tk-row"><button class="btn" id="bkFile">из файла…</button><button class="btn" id="bkDry">проверить</button><button class="btn ok" id="bkGo">сохранить</button><button class="btn" id="bkX">закрыть</button>'
      + '<input type="file" id="bkInp" accept=".txt,.md" style="display:none"></div><div id="bkRep"></div>');
    let busy = false;
    const run = async dry => {
      if(busy) return; busy = true; m.q('#bkGo').disabled = m.q('#bkDry').disabled = true;   // двойной клик раньше плодил копии
      const rep = m.q('#bkRep'); rep.innerHTML = '<div class="tk-lead">' + (dry ? 'проверяю…' : 'сохраняю…') + '</div>';
      const r = await api('/api/tasks/import', { text: m.q('#bkT').value, dry }).catch(() => null);
      busy = false; m.q('#bkGo').disabled = m.q('#bkDry').disabled = false;
      if(!r){ rep.innerHTML = '<div class="tk-msg err">сервер не ответил</div>'; return; }
      if(!r.tasks.length){ rep.innerHTML = '<div class="tk-msg err">Не нашла ни одной задачи. Каждая начинается со строки «=== Название | язык | раздел».</div>'; return; }
      const sw = await Promise.all(r.tasks.map(t => t.task ? sectionWarn(t.task.group) : ''));
      rep.innerHTML = '<div class="rep">' + r.tasks.map((t, ti) => '<div>' + (t.isNew ? '＋' : '↻') + ' <b>' + esc(t.title) + '</b> — вопросов ' + t.stats.steps + ', вариантов ' + t.stats.options
        + (t.report.created ? ', новых кусков ' + t.report.created : '')
        + (t.report.converted ? ', «кусок:» → ссылка на задачу: ' + t.report.converted : '')
        + (sw[ti] ? '<div class="bad">' + esc(sw[ti]) + '</div>' : '')
        + (t.report.unresolved.length ? '<div class="bad">' + unresolvedHtml(t.report.unresolved, String(ti)) + '</div>' : '') + '</div>').join('')
        + ((r.warnings || []).length ? '<div class="bad">' + r.warnings.map(esc).join('<br>') + '</div>' : '') + '</div>'
        + (dry ? '' : '<div class="tk-msg ok">✓ Сохранено.</div>');
      const lists = {}; r.tasks.forEach((t, ti) => lists[ti] = t.report.unresolved);
      bindUnresolved(rep, lists, (tag, u, c) => { const ta = m.q('#bkT'); const nt = applyCandidate(ta.value, r.tasks[+tag].title, u, c); if(nt != null){ ta.value = nt; run(true); } });
      if(!dry) reload();
    };
    m.q('#bkDry').onclick = () => run(true);
    m.q('#bkGo').onclick = () => run(false);
    m.q('#bkX').onclick = m.close;
    m.q('#bkFile').onclick = () => m.q('#bkInp').click();
    m.q('#bkInp').onchange = async e => { const f = e.target.files[0]; if(f) m.q('#bkT').value = await f.text(); e.target.value = ''; };
  };

  // ── промпт для ИИ ──
  // Раздел берётся из общего дерева (library/_sections.json): по нему в запрос уходят и уже имеющиеся задачи
  // с их развилками (чтобы ИИ не повторялся), и — по галочке — названия кусков этого раздела для ссылок.
  $('#tkPrompt').onclick = async () => {
    const rows = [...(await TaskWalk.rows()).values()];
    const cfg = await api('/api/sections').catch(() => ({ tree: [] }));
    const tree = cfg.tree || [];
    const langs = [...new Set(rows.map(r => r.lang).concat(LIST.map(t => t.lang)).filter(Boolean))].sort();
    const m = modal('<h3>Промпт для ИИ</h3>'
      + '<div class="tk-help">Запрос, по которому любой чат напишет задачи сразу в нужном формате. Ответ вставь в «пачкой». Раздел — из общего дерева (Опись → дерево разделов).</div>'
      + '<div class="mfield"><label>Тема: какие задачи нужны</label><input id="prTopic" placeholder="например: формы и проверка ввода; работа со списками; запросы к API"></div>'
      + '<div style="display:grid;grid-template-columns:1fr 3fr 1fr;gap:10px"><div class="mfield"><label>Язык</label><select id="prLang">' + langs.map(l => '<option' + (l === (LANG || 'js') ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></div>'
      + '<div class="mfield"><label>Раздел</label><select id="prSec"></select></div>'
      + '<div class="mfield"><label>Сколько задач</label><input id="prN" type="number" value="5" min="1" max="30"></div></div>'
      + '<label class="tk-help" style="display:flex;gap:6px;align-items:center;margin:-2px 0 8px"><input type="checkbox" id="prPieces" checked> <span id="prPiecesL">приложить названия кусков раздела</span></label>'
      + '<div class="mfield"><label>Запрос</label><textarea id="prOut" rows="16" spellcheck="false"></textarea></div>'
      + '<div class="tk-row"><button class="btn ok" id="prCopy">⧉ скопировать</button><button class="btn" id="prX">закрыть</button></div>');
    const nk = s => String(s || '').split('/').map(x => x.trim().toLowerCase().replace(/ё/g, 'е')).filter(Boolean).join(' / ');
    const inSecPath = (group, sec) => { const g = nk(group), k = nk(sec); return !!k && (g === k || g.startsWith(k + ' / ')); };
    const fillSec = () => {
      const l = m.q('#prLang').value, cur = m.q('#prSec').value;
      const n = sec => { const t = LIST.filter(x => (x.lang || '') === l && inSecPath(x.group, sec)).length, p = rows.filter(r => r.lang === l && inSecPath(r.group, sec)).length;
        return (t || p) ? '  (задач ' + t + ' · кусков ' + p + ')' : ''; };
      m.q('#prSec').innerHTML = '<option value="">— без раздела —</option>' + tree.map(t => '<option value="' + esc(t.name) + '">' + esc(t.name) + n(t.name) + '</option>'
        + (t.subs || []).map(sb => { const v = t.name + ' / ' + sb; return '<option value="' + esc(v) + '">   ' + esc(sb) + n(v) + '</option>'; }).join('')).join('');
      if(cur) m.q('#prSec').value = cur;
    };
    const FULL = new Map();   // полные задачи раздела — для перечня вопросов
    const fullOf = async ids => { await Promise.all(ids.filter(id => !FULL.has(id)).map(id => api('/api/tasks/get?id=' + encodeURIComponent(id)).then(t => FULL.set(id, t)).catch(() => {}))); return ids.map(id => FULL.get(id)).filter(Boolean); };
    // коротко: название, раздел и вопросы с вариантами — ИИ видит, что уже покрыто
    const outline = t => { const out = ['• ' + t.title + (t.group ? '  [' + t.group + ']' : '')];
      const walk = (steps, pad) => (steps || []).forEach(st => { out.push(st.auto && st.options.length === 1 ? pad + '! ' + (st.q || st.options[0].label)
          : pad + '? ' + (st.q || '') + ' — ' + st.options.map(o => o.label).join(' / '));
        st.options.forEach(o => walk(o.steps, pad + '    ')); });
      walk(t.steps, '    '); return out.join('\n'); };
    let bSeq = 0;
    const build = async () => {
      const my = ++bSeq;
      const l = m.q('#prLang').value, sec = m.q('#prSec').value, n = m.q('#prN').value || 5;
      const inSec = sec ? LIST.filter(t => (t.lang || '') === l && inSecPath(t.group, sec)) : [];
      const secFull = await fullOf(inSec.map(t => t.id)); if(my !== bSeq) return;
      const others = LIST.filter(t => !inSec.includes(t));
      const topic = m.q('#prTopic').value.trim() || (sec ? sec : 'самые частые повседневные задачи');
      const pool = sec ? rows.filter(r => r.lang === l && inSecPath(r.group, sec)) : [];
      const titles = m.q('#prPieces').checked ? pool.map(r => r.title).slice(0, 400) : [];
      m.q('#prPiecesL').textContent = sec ? 'приложить названия кусков раздела: ' + Math.min(pool.length, 400) + ' шт., ~' + Math.round(pool.slice(0, 400).reduce((a, r) => a + r.title.length, 0) / 3.5) + ' токенов' : 'приложить названия кусков (выбери раздел)';
      const sub = sec && sec.includes(' / ') ? sec : '';
      m.q('#prOut').value = [
        'Ты помогаешь наполнять мою базу «задач» — деревьев решений для программирования. Язык: ' + l + '. Тема: ' + topic + '.',
        (sec ? 'Раздел: «' + sec + '». В строке «===» третьим полем пиши ' + (sub ? 'ровно его' : 'его, а через « / » — один из подразделов: ' + ((tree.find(t => t.name === sec) || {}).subs || []).join(', ')) + '.\n' : '')
          + 'Напиши ' + n + ' задач. Задача — это то, что человек хочет сделать («Отправить форму без перезагрузки»), а внутри — вопросы-развилки с вариантами. Вопросы задавай так, чтобы понял новичок, а варианты — короткие и конкретные.',
        '',
        'Формат строго такой (без markdown вокруг, без пояснений до и после):',
        FORMAT_HELP,
        '',
        'Правила:',
        '- Отступ (2 пробела) задаёт вложенность. Вопрос под вариантом показывается только тому, кто выбрал этот вариант.',
        '- Строка «|» под вопросом — подсказка простыми словами, под вариантом — когда его выбрать.',
        '- «-> кусок:» пиши ТОЛЬКО с точным названием из списка ниже. Если подходящего куска нет — пиши «-> код» и короткий рабочий код (3–15 строк) в ```.',
        '- «-> задача:» — ссылка на другую задачу (из моего списка или из этой же пачки).',
        '- Добавляй вариант «-> пропустить», если шаг бывает не нужен.',
        '- В коде используй обычные имена; если вариант зависит от имени из прошлого шага — используй то же имя.',
        '',
        sec ? (secFull.length ? 'Что уже есть в разделе «' + sec + '» (не повторяй эти задачи и их развилки; можно углубить, дополнить или сослаться через «-> задача:»):\n' + secFull.map(outline).join('\n') : 'В разделе «' + sec + '» задач пока нет.') : '',
        others.length ? (sec ? 'Другие мои задачи' : 'Мои задачи') + ' (не повторяй, но можешь ссылаться):\n' + others.map(t => t.title).join('\n') : (inSec.length ? '' : 'Моих задач пока нет.'),
        '',
        titles.length ? 'Мои куски этого раздела (названия для «-> кусок:»):\n' + titles.join('\n') : 'Готовые куски не прикладываю — пиши код в вариантах.'
      ].join('\n');
    };
    fillSec(); build();
    m.q('#prLang').onchange = () => { fillSec(); build(); };
    ['#prSec', '#prN', '#prPieces'].forEach(s => m.q(s).onchange = build);
    m.q('#prTopic').oninput = build;
    m.q('#prCopy').onclick = e => copy(m.q('#prOut').value, e.target);
    m.q('#prX').onclick = m.close;
  };

  $('#tkNew').onclick = () => editTask(null);
  reload();
})();
