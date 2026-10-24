// Вкладки редактора в песочнице: вместо стопки панелей — полоса вкладок сверху и один активный редактор.
// Надстройка над window.codelabSandbox (sandbox.js) и workspace.js: сами панели .sb-ed не трогаем,
// только показываем активную и строим над ними вкладки. Пометка «не сохранено» берётся из класса
// .ws-dirty, который ставит workspace.js на файлы проекта (локальные панели живут в localStorage).
(function(){
  const sb = window.codelabSandbox;
  const eds = document.getElementById('sbEds');
  if(!sb || !eds || !eds.parentNode){ return; }

  // обернуть #sbEds в колонку с полосой вкладок сверху
  const col = document.createElement('div'); col.className = 'sb-edcol';
  eds.parentNode.insertBefore(col, eds);
  const tabs = document.createElement('div'); tabs.className = 'sb-tabs'; tabs.id = 'sbTabs';
  col.appendChild(tabs); col.appendChild(eds);
  eds.classList.add('tabbed');

  const uid = () => 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  let activeId = null;
  try { activeId = localStorage.getItem('codelab_sb_active') || null; } catch(_){}

  const files = () => sb.getFiles();
  const edList = () => [...eds.querySelectorAll('.sb-ed')];
  const headDirty = idx => { const ed = edList()[idx]; const h = ed && ed.querySelector('.sb-ed-head'); return !!(h && h.classList.contains('ws-dirty')); };

  function activeFile(){ const fs = files(); return fs.find(f => f.id === activeId) || fs[0] || null; }
  function applyActive(){
    const fs = files(); const af = activeFile(); if(af) activeId = af.id;
    const i = af ? fs.indexOf(af) : -1;
    edList().forEach((ed, idx) => ed.classList.toggle('sb-active', idx === i));
  }
  function setActive(id, focus){
    activeId = id; try { localStorage.setItem('codelab_sb_active', id); } catch(_){}
    applyActive(); buildTabs();
    if(focus){ const i = files().findIndex(f => f.id === id); const ed = edList()[i]; if(ed){ const ta = ed.querySelector('textarea'); if(ta) ta.focus(); } }
  }
  function closeTab(id){
    const fs = files(); const idx = fs.findIndex(f => f.id === id); if(idx < 0) return;
    if(headDirty(idx) && !confirm('Файл «' + (fs[idx].name || '') + '» не сохранён. Закрыть вкладку?')) return;
    const next = fs[idx + 1] || fs[idx - 1];
    const arr = fs.filter(x => x.id !== id);
    if(!arr.length){ sb.setFiles([{ id: uid(), name: 'файл.txt', lang: 'txt', code: '' }]); const nf = files()[0]; if(nf) setActive(nf.id); return; }
    sb.setFiles(arr);
    if(next) setActive(next.id); else applyActive(), buildTabs();
  }
  function reorder(fromId, toId){
    const fs = [...files()]; const fi = fs.findIndex(x => x.id === fromId), ti = fs.findIndex(x => x.id === toId);
    if(fi < 0 || ti < 0 || fi === ti) return;
    const [m] = fs.splice(fi, 1); fs.splice(ti, 0, m);
    sb.setFiles(fs); applyActive(); buildTabs();
  }
  function buildTabs(){
    const fs = files(); tabs.innerHTML = '';
    fs.forEach((f, idx) => {
      const t = document.createElement('div'); t.className = 'sb-tab' + (f.id === activeId ? ' on' : ''); t.draggable = true; t.dataset.id = f.id;
      if(headDirty(idx)){ const d = document.createElement('span'); d.className = 'tb-dot'; d.textContent = '●'; d.title = 'не сохранено'; t.appendChild(d); }
      const nm = document.createElement('span'); nm.className = 'tb-nm'; nm.textContent = f.name || ('файл ' + (idx + 1)); nm.title = f.path || f.name || ''; t.appendChild(nm);
      const x = document.createElement('span'); x.className = 'tb-x'; x.textContent = '×'; x.title = 'закрыть вкладку'; x.onclick = e => { e.stopPropagation(); closeTab(f.id); }; t.appendChild(x);
      t.onclick = () => setActive(f.id, true);
      t.addEventListener('dragstart', e => { try { e.dataTransfer.setData('text/plain', f.id); } catch(_){} t.classList.add('dragging'); });
      t.addEventListener('dragend', () => t.classList.remove('dragging'));
      t.addEventListener('dragover', e => { e.preventDefault(); t.classList.add('drag-over'); });
      t.addEventListener('dragleave', () => t.classList.remove('drag-over'));
      t.addEventListener('drop', e => { e.preventDefault(); t.classList.remove('drag-over'); let from = ''; try { from = e.dataTransfer.getData('text/plain'); } catch(_){} if(from && from !== f.id) reorder(from, f.id); });
      tabs.appendChild(t);
    });
  }

  // набор панелей изменился (открыли/закрыли/переставили файл) — пересобрать
  new MutationObserver(() => { applyActive(); buildTabs(); }).observe(eds, { childList: true });
  // ввод в коде → обновить точки «не сохранено» (с небольшой задержкой)
  let dt = null; eds.addEventListener('input', () => { clearTimeout(dt); dt = setTimeout(buildTabs, 400); }, true);
  // workspace.js помечает .ws-dirty на заголовке — ловим смену класса, чтобы точка появлялась/исчезала
  new MutationObserver(() => { clearTimeout(dt); dt = setTimeout(buildTabs, 150); }).observe(eds, { subtree: true, attributes: true, attributeFilter: ['class'] });

  applyActive(); buildTabs();
})();
