// Рабочая папка проекта в песочнице: дерево файлов слева, открытие и сохранение НАСТОЯЩИХ файлов на диске.
// Подключается после sandbox.js (в constructor.html). Сам sandbox.js должен отдавать window.codelabSandbox —
// см. WORKSPACE-PATCHES.md. Стили вставляются отсюда, style.css не трогаем.
(function(){
  const sb = window.codelabSandbox;
  const box = document.getElementById('sandbox');
  const bar = box && box.querySelector('.sb-bar');
  if(!sb || !box || !bar){ console.warn('workspace.js: нет window.codelabSandbox — примените правку к sandbox.js'); return; }

  // расширение → язык из единого источника (langs.js); запасной — минимальный
  const langOf = n => { const ext = (String(n).split('.').pop() || '').toLowerCase(); return window.langByExt ? window.langByExt(ext) : ({ html:'html', css:'css', js:'js', py:'python', json:'json' }[ext] || 'txt'); };
  const base = p => String(p).split('/').pop();
  const hash = s => { let h = 5381; s = String(s); for(let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return s.length + ':' + h; };
  const uid = () => 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const api = async (url, body) => {
    const r = await fetch(url, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    let j = {}; try { j = await r.json(); } catch(_){}
    if(!r.ok){ const e = new Error(j.error || ('ошибка ' + r.status)); e.status = r.status; e.data = j; throw e; }
    return j;
  };

  // ── стили ──
  const st = document.createElement('style');
  st.textContent = `
  .ws-panel{flex:0 0 232px;width:232px;display:none;flex-direction:column;gap:6px;min-height:0;margin-right:8px;border:1px solid var(--border,#3a2f55);border-radius:8px;padding:8px;background:var(--bg2,#150a2b);overflow:hidden}
  .ws-panel.on{display:flex}
  .ws-top{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
  .ws-root{font-size:11px;color:var(--muted,#9a93b5);word-break:break-all;cursor:pointer;line-height:1.3}
  .ws-root:hover{color:var(--text,#eee);text-decoration:underline}
  .ws-tree{flex:1;min-height:0;overflow:auto;font-size:12.5px}
  .ws-row{display:flex;align-items:center;gap:4px;padding:2px 4px;border-radius:5px;cursor:pointer;white-space:nowrap}
  .ws-row:hover{background:rgba(255,255,255,.07)}
  .ws-row.open{background:rgba(82,242,201,.12)}
  .ws-row .nm{flex:1;overflow:hidden;text-overflow:ellipsis}
  .ws-row.bin .nm{opacity:.4;cursor:default}
  .ws-row .act{display:none;gap:2px}.ws-row:hover .act{display:flex}
  .ws-row .act span{opacity:.7;padding:0 2px}.ws-row .act span:hover{opacity:1}
  .ws-msg{font-size:11.5px;min-height:15px;color:var(--muted,#9a93b5)}
  .ws-msg.err{color:#ff8a8a}.ws-msg.ok{color:#52F2C9}
  .ws-badge{font-size:11px;opacity:.75;margin-left:2px}
  .ws-save{padding:2px 7px!important}
  .sb-ed-head.ws-dirty .sb-name{border-color:#ffb454!important}
  .sb-ed-head.ws-dirty::after{content:'●';color:#ffb454;font-size:12px;margin-left:2px}
  .ws-drop{outline:2px dashed #52F2C9;outline-offset:-4px}
  `;
  document.head.appendChild(st);

  // ── панель ──
  const panel = document.createElement('div'); panel.className = 'ws-panel';
  panel.innerHTML =
    '<div class="ws-top">' +
      '<button class="btn" id="wsRefresh" title="обновить дерево">⟳</button>' +
      '<button class="btn" id="wsNewFile" title="новый файл в проекте">+ файл</button>' +
      '<button class="btn" id="wsNewDir" title="новая папка">+ папка</button>' +
      '<button class="btn" id="wsSaveAll" title="сохранить все изменённые файлы (Ctrl+S — текущий)">💾 все</button>' +
    '</div>' +
    '<div class="ws-root" id="wsRoot" title="нажми, чтобы выбрать другую папку проекта">…</div>' +
    '<div class="ws-tree" id="wsTree"></div>' +
    '<div class="ws-msg" id="wsMsg"></div>';
  box.prepend(panel);
  const $ = s => panel.querySelector(s);
  const msg = (t, kind) => { const m = $('#wsMsg'); m.textContent = t || ''; m.className = 'ws-msg' + (kind ? ' ' + kind : ''); if(t) clearTimeout(msg.t), msg.t = setTimeout(() => { if(m.textContent === t) m.textContent = ''; }, 6000); };

  // кнопки в панели песочницы
  const bProj = document.createElement('button'); bProj.className = 'btn'; bProj.id = 'sbProject'; bProj.textContent = '📂 проект'; bProj.title = 'файлы проекта на диске: открыть, править, сохранять';
  const bPick = document.createElement('button'); bPick.className = 'btn'; bPick.textContent = '⬆ файлы'; bPick.title = 'открыть файлы с компьютера в панели (можно и перетащить их в окно редакторов)';
  const picker = document.createElement('input'); picker.type = 'file'; picker.multiple = true; picker.style.display = 'none';
  const addBtn = bar.querySelector('#sbAdd');
  if(addBtn){ addBtn.before(bProj); addBtn.before(bPick); } else { bar.prepend(bProj, bPick); }
  bar.appendChild(picker);

  let root = '', entries = [], collapsed = new Set(), loaded = false;
  try { collapsed = new Set(JSON.parse(localStorage.getItem('codelab_ws_collapsed') || '[]')); } catch(_){}
  const saveCollapsed = () => { try { localStorage.setItem('codelab_ws_collapsed', JSON.stringify([...collapsed])); } catch(_){} };

  const files = () => sb.getFiles();
  const byPath = p => files().find(f => f.path === p);

  // ── дерево ──
  function renderTree(){
    const tree = $('#wsTree'); tree.innerHTML = '';
    $('#wsRoot').textContent = root || '…';
    if(!entries.length){ const e = document.createElement('div'); e.className = 'ws-msg'; e.textContent = 'папка пуста — создай файл или перетащи файлы в окно'; tree.appendChild(e); return; }
    const hidden = [];
    entries.forEach(en => {
      if(hidden.some(h => en.path.startsWith(h + '/'))) return;
      const depth = en.path.split('/').length - 1;
      const row = document.createElement('div'); row.className = 'ws-row'; row.style.paddingLeft = (4 + depth * 12) + 'px';
      const ic = document.createElement('span'), nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = base(en.path);
      nm.title = en.path;
      if(en.type === 'dir'){
        const c = collapsed.has(en.path); ic.textContent = c ? '▸' : '▾'; if(c) hidden.push(en.path);
        row.onclick = () => { if(collapsed.has(en.path)) collapsed.delete(en.path); else collapsed.add(en.path); saveCollapsed(); renderTree(); };
      } else {
        ic.textContent = '·';
        if(!en.text){ row.classList.add('bin'); nm.title = en.path + ' — не текстовый файл или больше 2 МБ'; }
        else row.onclick = () => openPath(en.path);
        if(byPath(en.path)) row.classList.add('open');
      }
      const act = document.createElement('span'); act.className = 'act';
      const ren = document.createElement('span'); ren.textContent = '✎'; ren.title = 'переименовать';
      ren.onclick = async ev => { ev.stopPropagation(); const to = prompt('Новое имя (путь внутри проекта):', en.path); if(!to || to === en.path) return;
        try { await api('/api/ws/rename', { from: en.path, to }); files().forEach(f => { if(f.path === en.path){ f.path = to; f.name = base(to); } else if(f.path && f.path.startsWith(en.path + '/')) f.path = to + f.path.slice(en.path.length); }); sb.refresh(); msg('переименовано', 'ok'); await load(); } catch(e){ msg(e.message, 'err'); } };
      const del = document.createElement('span'); del.textContent = '🗑'; del.title = 'удалить (уйдёт в папку .codelab-trash проекта)';
      del.onclick = async ev => { ev.stopPropagation(); if(!confirm('Удалить «' + en.path + '»?\nФайл переместится в .codelab-trash внутри проекта.')) return;
        try { await api('/api/ws/delete', { path: en.path }); msg('удалено в .codelab-trash', 'ok'); await load(); } catch(e){ msg(e.message, 'err'); } };
      act.append(ren, del);
      row.append(ic, nm, act); tree.appendChild(row);
    });
  }

  async function load(){
    try {
      const t = await api('/api/ws/tree');
      root = t.root; entries = t.entries; loaded = true;
      renderTree();
      if(t.truncated) msg('показаны не все файлы — слишком большая папка', 'err');
    } catch(e){ msg(e.message, 'err'); }
  }

  // ── открыть файл проекта в панели ──
  async function openPath(p){
    const ex = byPath(p);
    if(ex){ focusFile(ex); return; }
    try {
      const d = await api('/api/ws/file?path=' + encodeURIComponent(p));
      const f = { id: uid(), name: d.name, lang: d.lang, code: d.text, path: d.path, mtime: d.mtime, eol: d.eol, bom: d.bom, sh: hash(d.text) };
      // стартовые три файла (index.html / style.css / script.js) уступают место первому открытому файлу
      let cur = files();
      if(cur.length && cur.every(x => !x.path) && cur.length <= 3 && cur.every(x => /^f[1-3]$/.test(x.id))){
        cur = [];
      }
      sb.setFiles([...cur, f]);
      renderTree(); msg('открыт: ' + p, 'ok');
      setTimeout(() => focusFile(f), 30);
    } catch(e){ msg(e.message, 'err'); }
  }
  function focusFile(f){
    const i = files().indexOf(f), eds = box.querySelectorAll('.sb-ed');
    if(eds[i]){ eds[i].scrollIntoView({ block: 'nearest' }); const ta = eds[i].querySelector('textarea'); if(ta) ta.focus(); }
  }

  // ── сохранение ──
  async function saveFile(f, { force = false } = {}){
    let p = f.path;
    if(!p){
      p = prompt('Сохранить в проект как (путь внутри папки проекта):', f.name || 'файл.txt'); if(!p) return false;
      p = p.replace(/\\/g, '/').replace(/^\/+/, '');
      if(entries.some(e => e.type === 'file' && e.path === p) && !confirm('«' + p + '» уже есть в проекте. Перезаписать?')) return false;
      force = true;
    }
    try {
      const r = await api('/api/ws/save', { path: p, text: f.code, eol: f.eol, bom: f.bom, mtime: f.path ? f.mtime : undefined, force });
      f.path = r.path; f.mtime = r.mtime; f.sh = hash(f.code); if(!f.name || f.name !== base(r.path)) f.name = base(r.path);
      sb.refresh(); decorate(); msg('сохранено: ' + r.path, 'ok');
      if(!entries.some(e => e.path === r.path)) await load();
      return true;
    } catch(e){
      if(e.status === 409 && e.data && e.data.conflict){
        if(confirm('Файл «' + p + '» изменили вне лаборатории после того, как вы его открыли.\nПерезаписать вашей версией?')) return saveFile(f, { force: true });
        msg('не сохранено: файл изменён снаружи', 'err'); return false;
      }
      msg(e.message, 'err'); return false;
    }
  }
  const isDirty = f => f.sh != null ? hash(f.code) !== f.sh : false;
  async function saveAll(){
    const dirty = files().filter(f => f.path && isDirty(f));
    if(!dirty.length){ msg('нечего сохранять'); return; }
    let ok = 0; for(const f of dirty) if(await saveFile(f)) ok++;
    msg('сохранено файлов: ' + ok + ' из ' + dirty.length, ok === dirty.length ? 'ok' : 'err');
  }

  // ── пометки в заголовках редакторов ──
  function decorate(){
    const eds = box.querySelectorAll('.sb-ed'), list = files();
    eds.forEach((ed, i) => {
      const f = list[i], head = ed.querySelector('.sb-ed-head'); if(!f || !head) return;
      head.querySelectorAll('.ws-badge,.ws-save').forEach(x => x.remove());
      const badge = document.createElement('span'); badge.className = 'ws-badge'; badge.textContent = f.path ? '📁' : ''; badge.title = f.path ? 'файл проекта: ' + f.path : '';
      const sv = document.createElement('button'); sv.className = 'btn sb-run1 ws-save'; sv.textContent = '💾'; sv.title = f.path ? 'сохранить в ' + f.path + ' (Ctrl+S)' : 'сохранить в проект как файл';
      sv.onclick = () => saveFile(f);
      head.insertBefore(sv, head.querySelector('.sb-ed-del'));
      if(f.path) head.insertBefore(badge, head.querySelector('.sb-lang'));
      head.classList.toggle('ws-dirty', !!f.path && isDirty(f));
    });
  }
  new MutationObserver(decorate).observe(box.querySelector('#sbEds'), { childList: true });
  box.addEventListener('input', ev => { if(ev.target.classList && ev.target.classList.contains('sb-code')) decorate(); });
  decorate();

  // Ctrl+S в редакторе → сохранить этот файл
  box.addEventListener('keydown', ev => {
    if((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === 's'){
      ev.preventDefault();
      const ed = ev.target.closest && ev.target.closest('.sb-ed'); const i = ed ? [...box.querySelectorAll('.sb-ed')].indexOf(ed) : -1;
      if(i >= 0 && files()[i]) saveFile(files()[i]); else saveAll();
    }
  });
  window.addEventListener('beforeunload', ev => { if(files().some(f => f.path && isDirty(f))){ ev.preventDefault(); ev.returnValue = ''; } });

  // ── файлы с компьютера (выбор и перетаскивание) ──
  async function openLocal(list){
    const arr = [...list]; if(!arr.length) return;
    const added = [];
    for(const file of arr){
      if(file.size > 2 * 1024 * 1024){ msg('«' + file.name + '» больше 2 МБ — пропущен', 'err'); continue; }
      let text = await file.text();
      if(text.indexOf('\0') >= 0){ msg('«' + file.name + '» не текстовый — пропущен', 'err'); continue; }
      if(text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      text = text.replace(/\r\n/g, '\n');
      added.push({ id: uid(), name: file.name, lang: langOf(file.name), code: text });
    }
    if(!added.length) return;
    let cur = files();
    if(cur.length && cur.every(x => !x.path) && cur.length <= 3 && cur.every(x => /^f[1-3]$/.test(x.id))) cur = [];   // стартовые файлы уступают место
    sb.setFiles([...cur, ...added]);
    msg('открыто файлов: ' + added.length + ' (сохранить в проект — кнопкой 💾 у файла)', 'ok');
  }
  bPick.onclick = () => picker.click();
  picker.onchange = () => { openLocal(picker.files); picker.value = ''; };
  const eds = box.querySelector('#sbEds');
  ['dragenter', 'dragover'].forEach(n => eds.addEventListener(n, e => { if(e.dataTransfer && [...e.dataTransfer.types].includes('Files')){ e.preventDefault(); eds.classList.add('ws-drop'); } }));
  ['dragleave', 'drop'].forEach(n => eds.addEventListener(n, () => eds.classList.remove('ws-drop')));
  eds.addEventListener('drop', e => { if(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length){ e.preventDefault(); openLocal(e.dataTransfer.files); } });

  // ── панель: кнопки ──
  bProj.onclick = async () => { const on = !panel.classList.contains('on'); panel.classList.toggle('on', on); try { localStorage.setItem('codelab_ws_on', on ? '1' : '0'); } catch(_){} if(on && !loaded) await load(); else if(on) renderTree(); };
  $('#wsRefresh').onclick = load;
  $('#wsSaveAll').onclick = saveAll;
  $('#wsNewFile').onclick = async () => { const p = prompt('Имя нового файла (можно с папкой: src/app.js):'); if(!p) return;
    try { const r = await api('/api/ws/create', { path: p, text: '' }); await load(); await openPath(r.path); } catch(e){ msg(e.message, 'err'); } };
  $('#wsNewDir').onclick = async () => { const p = prompt('Имя новой папки:'); if(!p) return;
    try { await api('/api/ws/create', { path: p, dir: true }); await load(); } catch(e){ msg(e.message, 'err'); } };
  $('#wsRoot').onclick = async () => {
    let info = {}; try { info = await api('/api/ws/info'); } catch(_){}
    const hint = (info.recent && info.recent.length ? '\nнедавние:\n' + info.recent.join('\n') : '');
    const p = prompt('Полный путь к папке проекта (например C:\\проекты\\сайт):' + hint, root || info.root || ''); if(!p) return;
    try { await api('/api/ws/root', { path: p }); collapsed.clear(); await load(); msg('папка проекта выбрана', 'ok'); } catch(e){ msg(e.message, 'err'); }
  };

  let wasOn = false; try { wasOn = localStorage.getItem('codelab_ws_on') === '1'; } catch(_){}
  if(wasOn){ panel.classList.add('on'); load(); }
})();
