// Рецепты: название + описание + список кусков (из каталога). Хранятся на сервере.
let RECIPES = [], PIECES = [];
(async function(){
  try { PIECES = await fetch('/api/list').then(r => r.json()); } catch(_){ PIECES = []; }
  await reload();
})();
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const el = (t, c, h) => { const e = document.createElement(t); if(c) e.className = c; if(h != null) e.innerHTML = h; return e; };

async function reload(){
  try { RECIPES = await fetch('/api/recipes/list').then(r => r.json()); } catch(_){ RECIPES = []; }
  renderList();
}
function renderList(){
  const host = document.getElementById('list');
  document.getElementById('cnt').textContent = RECIPES.length;
  if(!RECIPES.length){ host.innerHTML = '<div class="empty">Рецептов пока нет. Рецепт — это название, описание и список кусков по порядку: «чтобы собрать X, нужны такие куски». Нажми «＋ новый рецепт».</div>'; return; }
  host.innerHTML = '';
  RECIPES.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).forEach(r => {
    const card = el('div', 'rc');
    card.innerHTML = '<div class="rc-t">' + esc(r.title) + '</div>'
      + (r.desc ? '<div class="rc-d">' + esc(r.desc) + '</div>' : '')
      + '<div class="rc-m">' + r.items + ' кусок(ов)</div>'
      + '<div class="rc-acts"><button class="btn" data-a="open">открыть</button><button class="btn" data-a="edit">править</button><button class="btn danger" data-a="del">удалить</button></div>';
    card.querySelector('[data-a=open]').onclick = () => openRecipe(r.id);
    card.querySelector('[data-a=edit]').onclick = () => editRecipe(r.id);
    card.querySelector('[data-a=del]').onclick = async () => { if(!confirm('Удалить рецепт «' + r.title + '»?')) return; await fetch('/api/recipes/delete', { method:'POST', body: JSON.stringify({ id: r.id }) }); reload(); };
    host.appendChild(card);
  });
}
function pieceTitle(id){ const p = PIECES.find(x => x.id === id); return p ? (p.title || id) : id; }
function pieceGroup(id){ const p = PIECES.find(x => x.id === id); return p ? (p.group || '') : ''; }

async function openRecipe(id){
  const r = await fetch('/api/recipes/get?id=' + encodeURIComponent(id)).then(x => x.json()).catch(() => null); if(!r) return;
  const bg = el('div', 'modal-bg'); const box = el('div', 'modal');
  box.innerHTML = '<h3>' + esc(r.title) + '</h3>' + (r.desc ? '<p class="mh">' + esc(r.desc) + '</p>' : '')
    + '<div class="rv-steps">' + (r.items.length ? r.items.map((it, i) =>
        '<div class="rv-step"><span class="rv-n">' + (i + 1) + '</span><div class="rv-b">'
        + '<a href="/component.html?id=' + encodeURIComponent(it.id) + '">' + esc(it.title || pieceTitle(it.id)) + '</a>'
        + (pieceGroup(it.id) ? ' <span class="rv-g">' + esc(pieceGroup(it.id)) + '</span>' : '')
        + (it.note ? '<div class="rv-note">' + esc(it.note) + '</div>' : '') + '</div></div>'
      ).join('') : '<div class="empty">кусков нет</div>') + '</div>'
    + '<div class="mbtns"><button class="btn ok" id="rv-copy">⧉ скопировать список</button><button class="btn" id="rv-close">закрыть</button></div>';
  bg.appendChild(box); document.body.appendChild(bg);
  bg.onclick = e => { if(e.target === bg) bg.remove(); };
  box.querySelector('#rv-close').onclick = () => bg.remove();
  box.querySelector('#rv-copy').onclick = e => {
    const txt = '# ' + r.title + '\n' + (r.desc ? r.desc + '\n' : '') + '\n' + r.items.map((it, i) => (i + 1) + '. ' + (it.title || pieceTitle(it.id)) + (it.note ? ' — ' + it.note : '')).join('\n');
    navigator.clipboard.writeText(txt); e.target.textContent = '✓ скопировано';
  };
}

function editRecipe(id){
  const existing = RECIPES.find(r => r.id === id);
  const bg = el('div', 'modal-bg'); const box = el('div', 'modal'); box.style.maxWidth = '720px';
  box.innerHTML = '<h3>' + (id ? 'Править рецепт' : 'Новый рецепт') + '</h3>'
    + '<div class="mfield"><label>Название</label><input id="r-title"></div>'
    + '<div class="mfield"><label>Описание — что собираем и зачем</label><textarea id="r-desc" rows="3"></textarea></div>'
    + '<div class="mfield"><label>Куски по порядку</label><div id="r-items" class="r-items"></div></div>'
    + '<div class="r-add"><input id="r-search" placeholder="найти кусок: по названию, теме или коду…"><div id="r-results" class="r-results"></div></div>'
    + '<div class="merr" id="r-err"></div>'
    + '<div class="mbtns"><button class="btn ok" id="r-save">💾 сохранить</button><button class="btn" id="r-close">отмена</button></div>';
  bg.appendChild(box); document.body.appendChild(bg);
  const q = s => box.querySelector(s);
  let items = [];   // {id,title,note}
  bg.onclick = e => { if(e.target === bg) bg.remove(); };
  q('#r-close').onclick = () => bg.remove();

  const draw = () => {
    const host = q('#r-items'); host.innerHTML = '';
    if(!items.length){ host.innerHTML = '<div class="muted" style="font-size:12px">пока пусто — найди куски ниже и добавь</div>'; }
    items.forEach((it, i) => {
      const row = el('div', 'r-it');
      row.innerHTML = '<span class="r-it-n">' + (i + 1) + '</span><span class="r-it-t">' + esc(it.title) + '</span>'
        + '<input class="r-it-note" placeholder="заметка (зачем этот кусок)" value="' + esc(it.note || '') + '">'
        + '<button class="mini" data-a="up" title="выше">↑</button><button class="mini" data-a="down" title="ниже">↓</button><button class="mini" data-a="rm" title="убрать">✕</button>';
      row.querySelector('.r-it-note').oninput = e => it.note = e.target.value;
      row.querySelector('[data-a=up]').onclick = () => { if(i > 0){ [items[i - 1], items[i]] = [items[i], items[i - 1]]; draw(); } };
      row.querySelector('[data-a=down]').onclick = () => { if(i < items.length - 1){ [items[i + 1], items[i]] = [items[i], items[i + 1]]; draw(); } };
      row.querySelector('[data-a=rm]').onclick = () => { items.splice(i, 1); draw(); };
      host.appendChild(row);
    });
  };
  // поиск куска: на сервере (название, описание, код, синонимы); без сервера — по названию и разделу, как раньше
  let rsSeq = 0, rsTimer = null;
  const search = () => {
    const v = (q('#r-search').value || '').toLowerCase().trim();
    const box2 = q('#r-results');
    clearTimeout(rsTimer);
    if(!v){ rsSeq++; box2.innerHTML = ''; return; }
    rsTimer = setTimeout(async () => {
      const seq = ++rsSeq; let list = null;
      try {
        const r = await fetch('/api/search?q=' + encodeURIComponent(v) + '&limit=12').then(r => r.json());
        const by = new Map(PIECES.map(p => [p.id, p]));
        if(r && Array.isArray(r.hits)) list = r.hits.map(h => by.get(h.id)).filter(Boolean);
      } catch(_){}
      if(seq !== rsSeq) return;
      if(!list) list = PIECES.filter(p => ((p.title || '') + ' ' + (p.group || '')).toLowerCase().includes(v)).slice(0, 12);
      box2.innerHTML = '';
      list.forEach(p => {
        const r = el('div', 'r-res');
        r.innerHTML = '<span>' + esc(p.title || p.id) + '</span><span class="r-res-g">' + esc((p.group || '').split('/')[0].trim()) + '</span>';
        r.onclick = () => { items.push({ id: p.id, title: p.title || p.id, note: '' }); q('#r-search').value = ''; box2.innerHTML = ''; draw(); };
        box2.appendChild(r);
      });
    }, 120);
  };
  q('#r-search').oninput = search;
  q('#r-save').onclick = async () => {
    const title = q('#r-title').value.trim();
    if(!title){ q('#r-err').textContent = 'впиши название'; return; }
    const body = { title, desc: q('#r-desc').value.trim(), items };
    if(id) body.id = id;
    const r = await fetch('/api/recipes/save', { method:'POST', body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({}));
    if(r.ok){ bg.remove(); reload(); } else q('#r-err').textContent = 'не сохранилось';
  };

  // заполнить при правке
  if(existing){
    fetch('/api/recipes/get?id=' + encodeURIComponent(id)).then(x => x.json()).then(full => {
      q('#r-title').value = full.title || ''; q('#r-desc').value = full.desc || '';
      items = (full.items || []).map(x => ({ id: x.id, title: x.title || pieceTitle(x.id), note: x.note || '' }));
      draw();
    });
  } else draw();
}
document.getElementById('new').onclick = () => editRecipe(null);
