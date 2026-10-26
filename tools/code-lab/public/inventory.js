// Опись: полные списки кусочков кода и схем со связями, с копированием.
let PIECES = [], FLOWS = [];

(async function(){
  try { PIECES = await fetch('/api/list').then(r => r.json()); } catch(_){ PIECES = []; }
  try { FLOWS = await fetch('/api/flows/list').then(r => r.json()); } catch(_){ FLOWS = []; }
  const leg = document.getElementById('covLegend');
  if(leg) leg.innerHTML = 'Описано: ' + [['inputs','Вх','Входы'],['outputs','Вых','Выходы'],['env','Ср','Среда'],['pre','Пр','Предусловия'],['effects','Эф','Побочные эффекты'],['errors','Ош','Ошибки'],['links','Св','Связи'],['check','Пв','Проверка']].map(f => '<span><b>' + f[1] + '</b> — ' + f[2] + '</span>').join('')
    + ' · <span class="muted">тип входа/выхода пиши через двоеточие: «сумма: число». Типы: ' + (window.CONTRACT_TYPES || []).map(t => '<span class="ct-ty" style="color:' + window.contractTypeColor(t) + ';border-color:' + window.contractTypeColor(t) + '55">' + t + '</span>').join(' ') + '</span>';
  fillFilters(); applyUrlFilters(); renderPieces(); renderFlows();
})();
// пресет фильтров из ссылки (навигатор «С чего начать» ведёт сюда: ?group=Интерфейс)
function applyUrlFilters(){
  const p = new URLSearchParams(location.search);
  const set = (id, v) => { const e = document.getElementById(id); if(e && v != null) e.value = v; };
  if(p.get('group')) set('pgroup', p.get('group'));
  if(p.get('lang')) set('plang', p.get('lang'));
  if(p.get('q')){ set('pq', p.get('q')); }
  if(p.get('tree') === '1'){ const c = document.getElementById('pgroupview'); if(c){ c.checked = true; } }
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const dispTitle = t => { const s = t.title || t.id; return window.codelabTitle ? window.codelabTitle(s) : s; };
const give = t => (t.comp && t.comp.provides) || [];
const need = t => (t.comp && t.comp.requires) || [];
// 8 граней «что описано» — ключ, буква, название, пояснение
const FACETS = [
  ['inputs',  'Вх',  'Входы',            'какие данные требуются'],
  ['outputs', 'Вых', 'Выходы',           'что возвращается и какого типа'],
  ['env',     'Ср',  'Среда',            'браузер / Node / библиотека'],
  ['pre',     'Пр',  'Предусловия',      'что должно быть создано до запуска'],
  ['effects', 'Эф',  'Побочные эффекты', 'меняет ли DOM, хранилище, сеть, время'],
  ['errors',  'Ош',  'Ошибки/ограничения','что может пойти не так'],
  ['links',   'Св',  'Связи',            'какие имена берёт извне (другие рецепты)'],
  ['check',   'Пв',  'Проверка',         'как понять, что фрагмент работает']
];
const cov = t => t.cov || {};
const covCount = t => FACETS.reduce((n, f) => n + (cov(t)[f[0]] ? 1 : 0), 0);
function covCell(t){
  return '<div class="cov">' + FACETS.map(f => {
    const on = !!cov(t)[f[0]];
    return '<span class="cov-d ' + (on ? 'on' : 'off') + '" title="' + esc(f[2] + ' — ' + f[3] + (on ? ' · есть' : ' · нет')) + '">' + esc(f[1]) + '</span>';
  }).join('') + '</div>';
}

// чипы контракта с типом: «имя: тип» → имя + цветной тег типа
function contractChips(arr){
  if(!arr || !arr.length) return '';
  return arr.map(s => {
    const it = window.contractParseItem ? window.contractParseItem(s) : { name: s, type: '' };
    const ty = it.type ? '<span class="ct-ty" style="color:' + window.contractTypeColor(it.type) + ';border-color:' + window.contractTypeColor(it.type) + '55">' + esc(it.type) + '</span>' : '';
    return '<span class="ct-item">' + esc(it.name) + ty + '</span>';
  }).join(' ');
}
function pieceRows(list){
  return list.map(t => {
    const g = give(t), n = need(t);
    return '<tr data-id="' + esc(t.id) + '">'
      + '<td class="t-title"><a href="/component.html?id=' + encodeURIComponent(t.id) + '">' + esc(dispTitle(t)) + '</a><div class="t-id">' + esc(t.id) + '</div></td>'
      + '<td>' + esc((t.lang || '').toUpperCase()) + '</td>'
      + '<td class="edit-cell" data-field="group" title="клик — сменить раздел">' + (t.group ? esc(t.group) : '<span class="muted">+ раздел</span>') + '</td>'
      + '<td class="give edit-cell" data-field="provides" title="клик — изменить (имя: тип)">' + (g.length ? contractChips(g) : '<span class="muted">+ отметить</span>') + '</td>'
      + '<td class="need edit-cell" data-field="requires" title="клик — изменить (имя: тип)">' + (n.length ? contractChips(n) : '<span class="muted">+ отметить</span>') + '</td>'
      + '<td>' + covCell(t) + '</td>'
      + '<td class="pc-act"><button class="mini pc-copy" data-id="' + esc(t.id) + '" title="скопировать как готовый шаблон (JSON) — вставить в сборник или загрузить как новый">⧉</button><button class="mini pc-move" data-id="' + esc(t.id) + '" title="переместить в раздел">📁</button><button class="mini pc-del" data-id="' + esc(t.id) + '" title="удалить кусок">🗑</button></td>'
      + '</tr>';
  }).join('');
}
// инлайн-редактирование ячеек «даёт/нужно»
document.getElementById('prows').addEventListener('click', e => {
  const cell = e.target.closest && e.target.closest('.edit-cell'); if(!cell) return;
  if(cell.querySelector('input')) return;
  const id = cell.parentElement.dataset.id, field = cell.dataset.field;
  const t = PIECES.find(x => x.id === id); if(!t) return;
  const isGroup = field === 'group';
  const cur = isGroup ? (t.group || '') : (field === 'provides' ? give(t) : need(t)).join(', ');
  cell.innerHTML = '<input class="inv-cell-in" value="' + esc(cur) + '" placeholder="' + (isGroup ? 'раздел / подраздел' : 'имена через запятую (можно «имя: тип»)') + '">';
  const inp = cell.querySelector('input'); inp.focus(); inp.select();
  const save = async () => {
    if(isGroup){
      const val = inp.value.trim();
      const r = await fetch('/api/edit', { method:'POST', body: JSON.stringify({ id, group: val }) }).then(r => r.json()).catch(() => ({}));
      if(r && r.ok) t.group = val;
      fillFilters(); renderPieces(); return;
    }
    const vals = inp.value.split(',').map(s => s.trim()).filter(Boolean);
    const r = await fetch('/api/edit', { method:'POST', body: JSON.stringify({ id, [field]: vals }) }).then(r => r.json()).catch(() => ({}));
    if(r && r.ok){ t.comp = t.comp || {}; t.comp[field] = vals; }
    renderPieces();
  };
  inp.addEventListener('blur', save, { once: true });
  inp.addEventListener('keydown', ev => { if(ev.key === 'Enter'){ ev.preventDefault(); inp.blur(); } if(ev.key === 'Escape'){ inp.removeEventListener('blur', save); renderPieces(); } });
});
// переместить кусок в другой раздел / удалить — работает и в таблице, и в дереве
async function movePiece(id){
  const t = PIECES.find(x => x.id === id); if(!t) return;
  const v = prompt('Раздел для «' + (t.title || id) + '» (подраздел через «/»). Пусто = без раздела:', t.group || '');
  if(v === null) return;
  const val = v.trim();
  const r = await fetch('/api/edit', { method:'POST', body: JSON.stringify({ id, group: val }) }).then(r => r.json()).catch(() => ({}));
  if(r && r.ok){ t.group = val; fillFilters(); renderPieces(); }
}
async function deletePiece(id){
  const t = PIECES.find(x => x.id === id); if(!t) return;
  if(!confirm('Удалить кусок «' + (t.title || id) + '»? Файл удалится без возврата.')) return;
  await fetch('/api/delete', { method:'POST', body: JSON.stringify({ id }) }).catch(() => {});
  try { PIECES = await fetch('/api/list').then(r => r.json()); } catch(_){ PIECES = PIECES.filter(x => x.id !== id); }
  fillFilters(); renderPieces();
}
// скопировать кусок как готовый шаблон (JSON) — вставить в сборник или загрузить как новый кусок
async function copyPiece(id, btn){
  let tpl; try { tpl = await fetch('/api/template?id=' + encodeURIComponent(id)).then(r => r.json()); } catch(_){ return; }
  // чистый переиспользуемый кусок: с разметкой lines (и пояснениями e), как принимает «📥 загрузить куски»
  const piece = { lang: tpl.lang || 'js', title: tpl.title || id, group: tpl.group || '', desc: tpl.desc || '', output: tpl.output || '', lines: tpl.lines || [] };
  const text = JSON.stringify(piece, null, 2);
  const done = () => { if(!btn) return; const o = btn.textContent; btn.textContent = '✓'; setTimeout(() => { btn.textContent = o; }, 900); };
  const fallback = () => { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch(_){} ta.remove(); done(); };
  if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
}
document.addEventListener('click', e => {
  const cp = e.target.closest && e.target.closest('.pc-copy'); if(cp){ e.preventDefault(); copyPiece(cp.dataset.id, cp); return; }
  const mv = e.target.closest && e.target.closest('.pc-move'); if(mv){ e.preventDefault(); movePiece(mv.dataset.id); return; }
  const dl = e.target.closest && e.target.closest('.pc-del'); if(dl){ e.preventDefault(); deletePiece(dl.dataset.id); return; }
});
const _val = id => { const e = document.getElementById(id); return e ? e.value : ''; };
// «неразложенный» кусок — без раздела или в дефолтной корзине (автораздел, не настоящая категория)
const _UNSORTED_BUCKETS = new Set(['', 'мои куски', 'разное', 'без раздела', 'мои шаблоны', 'мой сборник']);
function isUnsorted(t){ return _UNSORTED_BUCKETS.has(String(t.group || '').split('/')[0].trim().toLowerCase()); }
function filteredPieces(){
  const q = (document.getElementById('pq').value || '').toLowerCase().trim();
  const incompleteOnly = document.getElementById('pincomplete') && document.getElementById('pincomplete').checked;
  const lang = _val('plang'), group = _val('pgroup'), facet = _val('pfacet');
  let list = PIECES;
  if(q) list = list.filter(t => ((t.title || '') + ' ' + (t.id || '') + ' ' + (t.group || '') + ' ' + give(t).join(' ') + ' ' + need(t).join(' ')).toLowerCase().includes(q));
  if(lang) list = list.filter(t => String(t.lang || '').toLowerCase() === lang);
  if(group === '__unsorted__') list = list.filter(isUnsorted);   // быстрый фильтр «неразложенные»
  else if(group) list = list.filter(t => String(t.group || '').split('/')[0].trim() === group);   // по верхнему уровню раздела
  if(facet) list = list.filter(t => !cov(t)[facet]);           // показать только те, где этой грани НЕТ
  if(incompleteOnly) list = list.filter(t => covCount(t) < FACETS.length);
  return list;
}
// наполнить выпадашки языком/разделом (из данных) и гранями (из FACETS)
function fillFilters(){
  const langs = [...new Set(PIECES.map(t => String(t.lang || '').toLowerCase()).filter(Boolean))].sort();
  const groups = [...new Set(PIECES.map(t => String(t.group || '').split('/')[0].trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const opt = (v, label) => '<option value="' + esc(v) + '">' + esc(label) + '</option>';
  const pl = document.getElementById('plang'); if(pl) pl.innerHTML = opt('', 'язык: все') + langs.map(l => opt(l, l.toUpperCase())).join('');
  const nUnsorted = PIECES.filter(isUnsorted).length;
  const pg = document.getElementById('pgroup'); if(pg) pg.innerHTML = opt('', 'раздел: все') + (nUnsorted ? opt('__unsorted__', '⚠ без раздела (' + nUnsorted + ')') : '') + groups.map(g => opt(g, g)).join('');
  const pf = document.getElementById('pfacet'); if(pf) pf.innerHTML = opt('', 'не хватает: —') + FACETS.map(f => opt(f[0], 'нет: ' + f[2])).join('');
}
// дерево разделов: group «Сеть / Запросы» → вложенность по «/»
function buildTree(list){
  const root = { name: '', children: new Map(), items: [] };
  list.forEach(t => {
    const path = String(t.group || 'Без раздела').split('/').map(s => s.trim()).filter(Boolean);
    let node = root;
    (path.length ? path : ['Без раздела']).forEach(seg => {
      if(!node.children.has(seg)) node.children.set(seg, { name: seg, children: new Map(), items: [] });
      node = node.children.get(seg);
    });
    node.items.push(t);
  });
  return root;
}
function treeCount(node){ let n = node.items.length; node.children.forEach(c => n += treeCount(c)); return n; }
function gpPieceRow(t){
  const g = give(t), n = need(t);
  return '<div class="gp-piece">'
    + '<a href="/component.html?id=' + encodeURIComponent(t.id) + '">' + esc(dispTitle(t)) + '</a>'
    + '<span class="gp-lang">' + esc((t.lang || '').toUpperCase()) + '</span>'
    + (g.length ? '<span class="gp-cr give">даёт: ' + contractChips(g) + '</span>' : '')
    + (n.length ? '<span class="gp-cr need">нужно: ' + contractChips(n) + '</span>' : '')
    + '<span class="gp-sp"></span>' + covCell(t)
    + '<button class="mini pc-copy" data-id="' + esc(t.id) + '" title="скопировать как готовый шаблон (JSON)">⧉</button>'
    + '<button class="mini pc-move" data-id="' + esc(t.id) + '" title="переместить в раздел">📁</button>'
    + '<button class="mini pc-del" data-id="' + esc(t.id) + '" title="удалить кусок">🗑</button></div>';
}
function renderNode(node, depth){
  let html = '';
  // подразделы (сортировка по алфавиту), потом куски прямо в этом разделе
  const kids = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  kids.forEach(ch => {
    html += '<details class="tsec" open><summary><span class="tri">▶</span>'
      + '<span class="tname">' + esc(ch.name) + '</span><span class="tcnt">' + treeCount(ch) + '</span></summary>'
      + '<div class="tbody">' + renderNode(ch, depth + 1) + '</div></details>';
  });
  node.items.forEach(t => { html += gpPieceRow(t); });
  return html;
}
function renderGrouped(list){
  const host = document.getElementById('prows');
  // прячем таблицу, рисуем дерево в контейнере-замене
  let tree = document.getElementById('ptree');
  const table = host.closest('table');
  if(table) table.style.display = list.length ? 'none' : '';
  if(!tree){ tree = document.createElement('div'); tree.id = 'ptree'; tree.className = 'tree'; table.parentElement.appendChild(tree); }
  tree.style.display = '';
  tree.innerHTML = list.length ? renderNode(buildTree(list), 0) : '<div class="empty">ничего не нашлось</div>';
}
function renderPieces(){
  const list = filteredPieces();
  const grouped = document.getElementById('pgroupview') && document.getElementById('pgroupview').checked;
  const table = document.getElementById('prows').closest('table');
  const tree = document.getElementById('ptree');
  if(grouped){ renderGrouped(list); }
  else {
    if(tree) tree.style.display = 'none';
    if(table) table.style.display = '';
    document.getElementById('prows').innerHTML = list.length ? pieceRows(list) : '<tr><td colspan="7" class="empty">ничего не нашлось</td></tr>';
  }
  document.getElementById('pcnt').textContent = list.length + (list.length === PIECES.length ? '' : ' из ' + PIECES.length);
}
document.getElementById('pq').oninput = renderPieces;
['pincomplete', 'plang', 'pgroup', 'pfacet', 'pgroupview'].forEach(id => { const e = document.getElementById(id); if(e) e.onchange = renderPieces; });
// запоминаем «по разделам» между заходами
(function(){ const c = document.getElementById('pgroupview'); if(!c) return;
  try { c.checked = localStorage.getItem('codelab_inv_group') === '1'; } catch(_){}
  c.addEventListener('change', () => { try { localStorage.setItem('codelab_inv_group', c.checked ? '1' : '0'); } catch(_){} });
})();

function piecesAsText(){
  const list = filteredPieces();
  const lines = ['# Кусочки кода (' + list.length + ')', ''];
  list.forEach(t => {
    const g = give(t), n = need(t);
    lines.push('- ' + (t.title || t.id) + '  [' + (t.lang || '') + '] · ' + (t.group || '') + '  (описано ' + covCount(t) + '/' + FACETS.length + ')');
    if(g.length) lines.push('    даёт: ' + g.join(', '));
    if(n.length) lines.push('    нужно: ' + n.join(', '));
    const miss = FACETS.filter(f => !cov(t)[f[0]]).map(f => f[2]);
    if(miss.length) lines.push('    пробелы: ' + miss.join(', '));
  });
  return lines.join('\n');
}

function flowNodeLabel(nd){ return (nd && (nd.title || (nd.fields && (nd.fields.name || nd.fields.code && String(nd.fields.code).split('\n')[0])) || nd.blockId)) || '?'; }
async function loadFlowEdges(f){
  const full = await fetch('/api/flows/get?id=' + encodeURIComponent(f.id)).then(r => r.json()).catch(() => null);
  if(!full || !full.graph) return { nodes: [], nodeLabels: [], edges: [] };
  const byId = {}; (full.graph.nodes || []).forEach(n => byId[n.id] = n);
  const edges = (full.graph.edges || []).map(e => ({ from: flowNodeLabel(byId[e.from]), to: flowNodeLabel(byId[e.to]), kind: e.kind || 'data', src: e.src || '' }));
  const nodeLabels = (full.graph.nodes || []).map(flowNodeLabel);
  return { nodes: full.graph.nodes || [], nodeLabels, edges };
}
async function renderFlows(){
  const host = document.getElementById('flows');
  document.getElementById('fcnt').textContent = FLOWS.length;
  if(!FLOWS.length){ host.innerHTML = '<div class="empty">Сохранённых схем пока нет. Собери граф в Конструкторе и нажми «🗂 схемы».</div>'; return; }
  host.innerHTML = '';
  for(const f of FLOWS.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))){
    const { edges, nodeLabels } = await loadFlowEdges(f);
    const box = document.createElement('div'); box.className = 'flow';
    box.innerHTML = '<h3>' + esc(f.name) + '</h3><div class="fmeta">' + f.nodes + ' узлов · ' + f.edges + ' связей</div>'
      + (nodeLabels.length ? '<div class="fnodes muted"><b>узлы:</b> ' + nodeLabels.map(esc).join(' · ') + '</div>' : '')
      + (edges.length ? edges.map(e => { const r = (window.relationById && window.relationById(e.kind)) || { label: '', color: '#888' }; return '<div class="edge"' + (e.src ? ' title="' + esc(e.src) + '"' : '') + '>' + esc(e.from) + ' <span class="arr" style="color:' + r.color + '">—[' + esc(r.label) + ']→</span> ' + esc(e.to) + (e.src ? ' <span class="muted" style="font-size:10.5px">· ' + esc(e.src) + '</span>' : '') + '</div>'; }).join('')
                      : '<div class="muted" style="font-size:12px">связей нет</div>');
    host.appendChild(box);
    f._edges = edges; f._nodeLabels = nodeLabels;
  }
}
function flowsAsText(){
  const lines = ['# Схемы и связи (' + FLOWS.length + ')', ''];
  FLOWS.forEach(f => {
    lines.push('## ' + f.name + '  (' + f.nodes + ' узлов, ' + f.edges + ' связей)');
    if((f._nodeLabels || []).length){ lines.push('  узлы: ' + f._nodeLabels.join(', ')); }
    (f._edges || []).forEach(e => { const r = (window.relationById && window.relationById(e.kind)) || { label: '' }; lines.push('  ' + e.from + ' —[' + r.label + ']-> ' + e.to); });
    lines.push('');
  });
  return lines.join('\n');
}

async function copy(text, btn){
  try { await navigator.clipboard.writeText(text); } catch(_){
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch(e){} ta.remove();
  }
  const o = btn.textContent; btn.textContent = '✓ скопировано'; setTimeout(() => btn.textContent = o, 1200);
}
document.getElementById('pcopy').onclick = e => copy(piecesAsText(), e.target);
// массовый перенос: все показанные (с учётом фильтров) → в один раздел
(function(){ const btn = document.getElementById('pmoveall'); if(!btn) return; btn.onclick = async () => {
  const list = filteredPieces();
  if(!list.length){ const o = btn.textContent; btn.textContent = 'нечего переносить'; setTimeout(() => btn.textContent = o, 1600); return; }
  const v = prompt('Переместить ВСЕ показанные (' + list.length + ' шт.) в раздел (подраздел через «/»). Пусто = без раздела:', '');
  if(v === null) return;
  const group = v.trim();
  const o = btn.textContent; btn.disabled = true; btn.textContent = 'переношу…';
  let done = 0;
  for(const t of list){ const r = await fetch('/api/edit', { method:'POST', body: JSON.stringify({ id: t.id, group }) }).then(x => x.json()).catch(() => ({})); if(r && r.ok){ t.group = group; done++; } }
  btn.disabled = false; btn.textContent = '✓ перенесено ' + done; fillFilters(); renderPieces();
  setTimeout(() => { btn.textContent = o; }, 2500);
}; })();
// убрать дубли — куски с одинаковым кодом схлопнуть в один
(function(){ const btn = document.getElementById('pdedup'); if(!btn) return; btn.onclick = async () => {
  if(!confirm('Схлопнуть куски с ОДИНАКОВЫМ кодом в один? Оставляется самый полный (с разделом/описанием/пояснениями), остальные удаляются без возврата.')) return;
  const o = btn.textContent; btn.disabled = true; btn.textContent = 'чищу…';
  let r; try { r = await fetch('/api/dedup', { method:'POST' }).then(x => x.json()); } catch(_){ r = null; }
  btn.disabled = false;
  if(r && r.ok){ btn.textContent = r.removed ? ('✓ удалено ' + r.removed + ' дублей') : 'дублей не нашлось'; try { PIECES = await fetch('/api/list').then(x => x.json()); } catch(_){} fillFilters(); renderPieces(); setTimeout(() => { btn.textContent = o; }, 3000); }
  else { btn.textContent = 'ошибка'; setTimeout(() => { btn.textContent = o; }, 2000); }
}; })();
document.getElementById('fcopy').onclick = e => copy(flowsAsText(), e.target);

// ── импорт связей/контрактов из текста ────────────────────────────────────────
const el2 = (tag, cls, html) => { const e = document.createElement(tag); if(cls) e.className = cls; if(html != null) e.innerHTML = html; return e; };
function split2(s, sep){ const i = s.indexOf(sep); return [s.slice(0, i), s.slice(i + sep.length)]; }
function resolveName(nm){ const q = String(nm || '').trim().toLowerCase(); return PIECES.find(t => (t.title || '').trim().toLowerCase() === q) || PIECES.find(t => t.id === String(nm || '').trim()) || null; }
// отрезать условие [если ...] и вернуть {text, cond}
function splitCond(s){ let cond = ''; const text = String(s || '').replace(/\[([^\]]*)\]/g, (_, c) => { cond = (cond ? cond + '; ' : '') + c.trim(); return ' '; }).trim(); return { text, cond }; }
// имя куска: берём содержимое первых «ёлочек»/кавычек; иначе строку как есть (условие уже убрано)
function cleanName(s){ const { text } = splitCond(s); const q = text.match(/[«„"'“]([^»"'”]+)[»"'”]/); return (q ? q[1] : text).trim(); }
// строка целиком в кавычках — одно имя (внутренние стрелки не разрезаем)
function fullyQuoted(line){
  const s = String(line || '').trim(); if(!/^[«„"'“]/.test(s)) return false;
  for(let i = 1; i < s.length; i++){ if(/[»"'”]/.test(s[i])) return i === s.length - 1; }
  return false;
}
// вид связи по ключевому слову В НАЧАЛЕ строки (для «дерева»: «— создаёт → …»)
function relFromStart(s){
  const low = String(s || '').trim().toLowerCase();
  for(const x of (window.relationKwIndex || [])){
    if(/^(->|→|=>)$/.test(x.k)) continue;
    if(low === x.k || low.startsWith(x.k + ' ') || low.startsWith(x.k + '→') || low.startsWith(x.k + ' →')){
      return { r: x.r, rest: s.trim().slice(x.k.length) };
    }
  }
  return null;
}
function parseLinks(text){
  const edges = [], contracts = [], errors = []; let flowName = '', subject = null, section = '';
  // swap:true — источник = второй кусок (напр. «A следует за B» = B→A); src хранит исходную строку
  const addEdge = (aName, bName, r, line, ln) => { let a = aName, b = bName; if(r.swap){ const t = a; a = b; b = t; } edges.push({ a, b, kind: r.id, ln, src: line }); };
  String(text).split('\n').forEach((raw, i) => {
    const line = raw.trim(); const ln = i + 1;
    if(!line) return;
    if(line.startsWith('#') || line.startsWith('//')){ const m = line.match(/схема[:\s]+(.+)/i); if(m) flowName = cleanName(m[1]); return; }
    let m;
    if((m = line.match(/^схема[:\s]+(.+)/i))){ flowName = cleanName(m[1]); return; }
    // раздел: X — задаёт текущий раздел для последующих «+ имя»
    if((m = line.match(/^(?:раздел|группа|категория)[:\s]+(.+)/i))){ section = cleanName(m[1]); return; }
    // + имя — положить кусок в текущий раздел
    if((m = line.match(/^\+\s*(.+)$/))){
      if(!section){ errors.push('строка ' + ln + ': «+ имя» без «раздел:» выше — «' + line + '»'); return; }
      contracts.push({ name: cleanName(m[1]), fields: { group: section }, ln }); return;
    }
    if(line.includes('::')){
      const [name, rest] = split2(line, '::'); const fields = {};
      rest.split(';').forEach(part => {
        const kv = part.split('='); if(kv.length < 2) return;
        const key = kv[0].trim().toLowerCase(), val = kv.slice(1).join('=').trim();
        const list = () => val.split(/[,،]/).map(s => s.trim()).filter(Boolean);
        if(/нужн|requir/.test(key)) fields.requires = list();
        else if(/да[её]т|provid|выда/.test(key)) fields.provides = list();
        else if(/сред|env|runtime/.test(key)) fields.runtime = list();
        else if(/предуслов|requirement/.test(key)) fields.requirements = list();
        else if(/ошиб|error|огранич/.test(key)) fields.errors = val;
        else if(/провер|check/.test(key)) fields.check = val;
        else if(/раздел|групп|категор|section|group/.test(key)) fields.group = val;
        else if(/^\s*вход|input/.test(key)) fields.input = val;
        else if(/^\s*выход|output/.test(key)) fields.output = val;
      });
      contracts.push({ name: cleanName(name), fields, ln }); return;
    }
    // «дерево»: строка с маркером — связь от текущего заголовка (subject)
    const bullet = line.match(/^[—–\-•*·]\s*(.+)$/);
    if(bullet){
      if(!subject){ errors.push('строка ' + ln + ': связь без заголовка куска выше — «' + line + '»'); return; }
      const rel = relFromStart(bullet[1]);
      if(!rel){ errors.push('строка ' + ln + ': не понял вид связи — «' + line + '»'); return; }
      const target = cleanName(rel.rest.replace(/^\s*(?:->|→|=>)\s*/, ''));
      if(!target){ errors.push('строка ' + ln + ': не понял цель связи — «' + line + '»'); return; }
      addEdge(subject, target, rel.r, line, ln); return;
    }
    // формат «A | связь | B» (как в экспортированной таблице связей): три части через «|»
    if(line.includes('|')){
      const parts = line.split('|').map(s => s.trim());
      if(parts.length === 3 && parts[0] && parts[1] && parts[2]){
        const rl = parts[1].toLowerCase();
        const rec = (window.relationKwIndex || []).find(x => x.k === rl);
        const r = rec ? rec.r : (window.CODE_RELATIONS || []).find(x => x.label.toLowerCase() === rl);
        if(r){ addEdge(cleanName(parts[0]), cleanName(parts[2]), r, line, ln); return; }
        errors.push('строка ' + ln + ': не понял вид связи «' + parts[1] + '» — «' + line + '»'); return;
      }
    }
    // строка целиком в кавычках — это имя куста (заголовок), а не связь
    if(fullyQuoted(line)){ subject = cleanName(line); return; }
    // плоский формат: цепочка стрелок A → B → C = поток данных по звеньям
    if(/(?:->|→|=>)/.test(line)){
      const parts = line.split(/\s*(?:->|→|=>)\s*/).map(cleanName).filter(Boolean);
      if(parts.length >= 2){ for(let k = 0; k < parts.length - 1; k++) edges.push({ a: parts[k], b: parts[k + 1], kind: 'data', ln, src: line }); return; }
    }
    // плоский формат: любой вид связи по ключевому слову из словаря
    const kws = (window.relationKwIndex || []).filter(x => !/^(->|→|=>)$/.test(x.k));
    let hit = null;
    for(const x of kws){
      const re = new RegExp('^(.+?)\\s+' + x.k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+(.+)$', 'i');
      const mm = line.match(re); if(mm){ hit = { a: mm[1].trim(), b: cleanName(mm[2].replace(/^(с|со|от|на|для|в|к)\s+/i, '')), r: x.r }; break; }
    }
    if(hit){
      // отрицание перед связью («A не зависит от B») — ребро не создаём
      if(/(^|\s)(не|ни)$/i.test(hit.a)){ errors.push('строка ' + ln + ': отрицание — ребро пропущено («' + line + '»)'); return; }
      // модальность/неуверенность («A может вызывать B», «иногда», «возможно») — лучше не создавать ложное ребро
      if(/(^|\s)(может|могут|могла|могли|мог|можно|возможно|иногда|редко|обычно|наверное|бы)$/i.test(hit.a)){ errors.push('строка ' + ln + ': модальность/неуверенность — ребро пропущено («' + line + '»)'); return; }
      addEdge(cleanName(hit.a), hit.b, hit.r, line, ln); return;
    }
    // заголовок куска: в «ёлочках»/кавычках или совпал с названием существующего куска
    const asName = cleanName(line);
    if(/^[«„"'“]/.test(line) || resolveName(asName)){ subject = asName; return; }
    errors.push('строка ' + ln + ': не понял — «' + line + '»');
  });
  return { edges, contracts, errors, flowName };
}
async function applyLinks(P){
  for(const c of P.contracts){
    const t = resolveName(c.name); if(!t) continue;
    const f = c.fields, body = { id: t.id };
    if(f.group) body.group = f.group;
    if(f.provides) body.provides = f.provides;
    if(f.requires) body.requires = f.requires;
    if(f.runtime || f.input || f.output || f.requirements || f.errors || f.check){
      const full = await fetch('/api/template?id=' + encodeURIComponent(t.id)).then(r => r.json()).catch(() => null);
      const comp = (full && full.component) || {};
      if(f.runtime){ comp.tags = Object.assign({}, comp.tags, { runtime: f.runtime }); }
      if(f.input || f.output || f.requirements){ comp.summary = Object.assign({}, comp.summary); if(f.input) comp.summary.input = f.input; if(f.output) comp.summary.output = f.output; if(f.requirements) comp.summary.requirements = f.requirements; }
      if(f.errors || f.check){ comp.views = Object.assign({}, comp.views); comp.views.check = Object.assign({}, comp.views.check); if(f.errors) comp.views.check.errors = f.errors; if(f.check) comp.views.check.expected_result = f.check; }
      body.component = comp;
    }
    await fetch('/api/edit', { method:'POST', body: JSON.stringify(body) }).catch(() => {});
  }
  const name = P.flowName || ('Импорт связей ' + new Date().toLocaleDateString('ru'));
  const createMissing = P.createMissing !== false;   // по умолчанию создаём ящики для ненайденных
  // дописываем в схему того же имени, а не затираем её: подхватываем существующий граф
  let existingId = null, baseNodes = [], baseEdges = [];
  try {
    const list = await fetch('/api/flows/list').then(r => r.json());
    const ex = (list || []).find(x => (x.name || '').trim().toLowerCase() === name.trim().toLowerCase());
    if(ex){ existingId = ex.id; const full = await fetch('/api/flows/get?id=' + encodeURIComponent(ex.id)).then(r => r.json()).catch(() => null);
      if(full && full.graph){ baseNodes = Array.isArray(full.graph.nodes) ? full.graph.nodes : []; baseEdges = Array.isArray(full.graph.edges) ? full.graph.edges : []; } }
  } catch(_){}
  const used = new Map(), nodes = baseNodes.slice(), edges = baseEdges.slice(); let col = nodes.length, missing = 0, addedN = 0, addedE = 0;
  // опознаём уже существующие узлы: кусок — по id, ящик — по имени (label:…)
  const identityOf = n => (n && n.src && n.src.id) ? n.src.id : ('label:' + String((n && n.title) || '').toLowerCase());
  nodes.forEach(n => used.set(identityOf(n), n.id));
  const place = () => ({ x: 60 + (col % 4) * 240, y: 60 + Math.floor(col / 4) * 170 });
  const newId = () => Math.random().toString(36).slice(2, 8);
  const ensureNode = async t => {
    if(used.has(t.id)) return used.get(t.id);
    const full = await fetch('/api/template?id=' + encodeURIComponent(t.id)).then(r => r.json()).catch(() => null);
    const code = ((full && full.lines) || []).map(l => (l || []).map(k => k.v != null ? k.v : '').join('')).join('\n');
    const nid = newId(); const p = place();
    nodes.push({ id: nid, blockId: 'raw', fields: { code }, title: t.title, desc: (full && full.desc) || '', src: { id: t.id, title: t.title, desc: (full && full.desc) || '', code }, x: p.x, y: p.y });
    col++; addedN++; used.set(t.id, nid); return nid;
  };
  // узел по имени: существующий кусок → полный узел; иначе ящик-ярлык (не сохранённый кусок)
  const nodeFor = async name => {
    const t = resolveName(name); if(t) return ensureNode(t);
    if(!createMissing) return null;
    const key = 'label:' + String(name).toLowerCase();
    if(used.has(key)) return used.get(key);
    const nid = newId(); const p = place();
    nodes.push({ id: nid, blockId: 'raw', fields: { code: '' }, title: name, desc: '(ящик данных — не сохранённый кусок)', x: p.x, y: p.y });
    col++; missing++; addedN++; used.set(key, nid); return nid;
  };
  for(const e of P.edges){
    const na = await nodeFor(e.a), nb = await nodeFor(e.b); if(na == null || nb == null) continue; const kind = e.kind || 'data';
    // ненаправленные связи (дубликат/конфликтует/альтернатива) — дубль в любом порядке; разные виды между одной парой разрешены
    const rel = (window.relationById && window.relationById(kind)) || { dir: 'd' };
    const dup = edges.some(x => (x.kind || 'data') === kind && (rel.dir === 'u'
      ? ((x.from === na && x.to === nb) || (x.from === nb && x.to === na))
      : (x.from === na && x.to === nb)));
    if(!dup){ edges.push({ from: na, to: nb, kind, src: e.src || '' }); addedE++; }
  }
  let flowId = null;
  if(nodes.length){
    const body = { name, graph: { nodes, edges } }; if(existingId) body.id = existingId;
    const r = await fetch('/api/flows/save', { method:'POST', body: JSON.stringify(body) }).then(r => r.json()).catch(() => ({}));
    flowId = r.id;
  }
  return { contracts: P.contracts.length, edges: addedE, nodes: addedN, missing, merged: !!existingId, totalEdges: edges.length, flowId };
}
const LINKS_SAMPLE = [
  '# Два формата. 1) плоский: Кусок A <вид> Кусок B (по строке на связь).',
  '# Стрелка -> (или →) = передаёт данные. Виды — в справочнике ниже.',
  '',
  'схема: Среднее по списку',
  'Массив чисел -> Сумма (reduce)',
  'Сумма (reduce) -> Среднее',
  'Среднее зависит от Сумма (reduce)',
  'Среднее следует за Сумма (reduce)',
  'Валидатор проверяет Среднее',
  'Старое среднее заменяет Среднее',
  '',
  '# 2) «дерево»: заголовок куска в «ёлочках», под ним связи с «—».',
  '# (пояснение) отбрасывается, [условие] сохраняется как основание.',
  '«Среднее»',
  '  — зависит от → «Сумма (reduce)»',
  '  — возвращает → «Число» (результат вычисления)',
  '  — передаёт данные → «Форматтер» [если нужно показать на экране]',
  '',
  'Среднее:: нужно=сумма, количество; даёт=среднее; среда=браузер; проверка=сравни с ручным счётом; раздел=Математика',
  '',
  '# разложить куски по разделам: «раздел: X», затем список через «+».',
  '# подразделы — через «/»: раздел: Сеть / Запросы',
  'раздел: Сеть / Запросы',
  '+ fetch + await — получить данные',
  '+ Парсер ответа API (columns/data)',
  'раздел: Сеть / Ошибки',
  '+ Запрос сломался — где и почему'
].join('\n');
function relationsRef(){
  const R = window.CODE_RELATIONS || [];
  const groups = {};
  R.forEach(r => { (groups[r.group] = groups[r.group] || []).push(r); });
  return Object.keys(groups).map(g =>
    '<div class="rr-g">' + esc(g) + '</div>' + groups[g].map(r =>
      '<div class="rr-row"><span class="rr-dot" style="background:' + r.color + '"></span>'
      + '<b>' + esc(r.label) + '</b> <span class="rr-kw">(' + esc(r.kw.slice(0, 3).join(', ')) + ')</span> — ' + esc(r.note) + '</div>'
    ).join('')
  ).join('');
}
function openLinksModal(){
  const bg = el2('div', 'modal-bg');
  const box = el2('div', 'modal');
  box.innerHTML = '<h3>Связи из текста</h3>'
    + '<p class="mh">Вставь правила — приложение разберёт связи и контракты кусков. Куски ищутся по названию. Связи соберутся в схему, контракты («нужно/даёт/среда/ошибка/проверка/вход/выход/<b>раздел</b>») запишутся на куски. Разложить по разделам можно блоком «<b>раздел: X</b>» и списком «<b>+ Имя куска</b>». Отрицания («A <b>не</b> зависит от B») и неуверенность («A <b>может</b> вызывать B») пропускаются.</p>'
    + '<div class="fmt">Плоско: A -> B · A зависит от B · A конфликтует с B …&#10;Дерево:  «Кусок A»&#10;             — создаёт → «Кусок B» (пояснение) [условие]&#10;Контракт: Имя:: нужно=x,y; даёт=z; среда=браузер; раздел=Сеть; проверка=…&#10;Разделы: раздел: Сеть / Запросы&#10;             + Имя куска   (подраздел — через «/»)&#10;схема: Название</div>'
    + '<details class="rr"><summary>виды связей, которые понимает парсер (' + (window.CODE_RELATIONS || []).length + ')</summary><div class="rr-box">' + relationsRef() + '</div></details>'
    + '<textarea id="lk-text" placeholder="вставь текст или нажми «пример»"></textarea>'
    + '<div class="mbtns"><button class="btn" id="lk-sample">пример</button><button class="btn" id="lk-suggest" title="предложить связи автоматически — по контрактам «даёт/нужно» кусков">✨ по контрактам</button><button class="btn" id="lk-aiprompt" title="собрать список кусков в запрос для ИИ (он предложит связи)">📋 куски → ИИ</button><button class="btn ok" id="lk-parse">разобрать</button><button class="btn" id="lk-apply" style="display:none">применить</button><button class="btn" id="lk-close">закрыть</button><label class="inv-chk" style="margin-left:auto"><input type="checkbox" id="lk-missing" checked> создавать узлы для ненайденных (ящики данных)</label></div>'
    + '<div class="lp-prev" id="lk-prev"></div>';
  bg.appendChild(box); document.body.appendChild(bg);
  const q = s => bg.querySelector(s);
  bg.onclick = e => { if(e.target === bg) bg.remove(); };
  q('#lk-close').onclick = () => bg.remove();
  q('#lk-sample').onclick = () => { q('#lk-text').value = LINKS_SAMPLE; };
  let parsed = null;
  function showPreview(){
    const prev = q('#lk-prev'); prev.innerHTML = '';
    const line = (txt, cls) => { const d = el2('div', 'lp-row ' + (cls || '')); d.textContent = txt; return d; };
    prev.appendChild(el2('div', 'lp-sec', 'связи (' + parsed.edges.length + ')'));
    const mk = !q('#lk-missing') || q('#lk-missing').checked;
    parsed.edges.forEach(e => { const a = resolveName(e.a), b = resolveName(e.b); const ok = a && b; const rel = (window.relationById && window.relationById(e.kind)) || { label: 'связь' }; const miss = [!a ? e.a : '', !b ? e.b : ''].filter(Boolean); const mark = ok ? '✓ ' : (mk ? '◻ ' : '✕ '); const tail = ok ? '' : (mk ? '  (ящик: ' + miss.join(', ') + ')' : '  (не найдено: ' + miss.join(', ') + ')'); prev.appendChild(line(mark + e.a + '  —[' + rel.label + ']→  ' + e.b + tail, ok ? 'lp-ok' : (mk ? '' : 'lp-bad'))); if(e.src && e.src !== (e.a + ' ' + e.b)) prev.appendChild(line('      ↳ ' + e.src, 'muted')); });
    prev.appendChild(el2('div', 'lp-sec', 'контракты (' + parsed.contracts.length + ')'));
    parsed.contracts.forEach(c => { const t = resolveName(c.name); prev.appendChild(line((t ? '✓ ' : '✕ ') + c.name + ': ' + Object.keys(c.fields).join(', ') + (t ? '' : '  (кусок не найден)'), t ? 'lp-ok' : 'lp-bad')); });
    if(parsed.errors.length){ prev.appendChild(el2('div', 'lp-sec', 'не разобрано')); parsed.errors.forEach(x => prev.appendChild(line(x, 'lp-bad'))); }
    q('#lk-apply').style.display = (parsed.edges.length || parsed.contracts.length) ? '' : 'none';
  }
  q('#lk-parse').onclick = () => { parsed = parseLinks(q('#lk-text').value); showPreview(); };
  // ✨ авто-предложение связей по контрактам «даёт/нужно»: A даёт имя X, B требует X → A передаёт данные B
  q('#lk-suggest').onclick = () => {
    const byProv = new Map();
    (PIECES || []).forEach(p => { const pr = (p.comp && p.comp.provides) || []; pr.forEach(n => { const k = String(n).toLowerCase(); if(!byProv.has(k)) byProv.set(k, []); byProv.get(k).push(p); }); });
    const edges = [], seen = new Set();
    (PIECES || []).forEach(b => { const rq = (b.comp && b.comp.requires) || []; rq.forEach(n => { const k = String(n).toLowerCase(); (byProv.get(k) || []).forEach(a => { if(a.id === b.id) return; const key = a.id + '>' + b.id + '>' + k; if(seen.has(key)) return; seen.add(key); edges.push({ a: a.title, b: b.title, kind: 'data', src: 'контракт: «' + a.title + '» даёт «' + n + '» → «' + b.title + '» требует' }); }); }); });
    parsed = { edges, contracts: [], errors: [], flowName: 'Связи по контрактам' };
    const prev = q('#lk-prev');
    if(!edges.length){ prev.innerHTML = '<div class="lp-row muted">по контрактам ничего не нашлось — у кусков должны быть заполнены «даёт/нужно» (provides/requires)</div>'; q('#lk-apply').style.display = 'none'; return; }
    showPreview();
  };
  // 📋 собрать список кусков в запрос для ИИ (он предложит связи в формате «A | связь | B»)
  q('#lk-aiprompt').onclick = () => {
    const list = (PIECES || []).map(p => { const c = p.comp || {}; const pr = (c.provides || []).join(', '), rq = (c.requires || []).join(', '); return '• ' + p.title + (pr ? ('  [даёт: ' + pr + ']') : '') + (rq ? ('  [нужно: ' + rq + ']') : ''); }).join('\n');
    const rels = (window.CODE_RELATIONS || []).map(r => r.label).join(', ');
    const prompt = 'Вот куски кода проекта (в скобках — что кусок даёт и что ему нужно). Предложи осмысленные связи между ними.\n'
      + 'Формат строго: «Название A | вид связи | Название B», по одной связи на строку.\n'
      + 'Вид связи выбирай из списка: ' + rels + '.\n'
      + 'Названия — точь-в-точь как в списке. Лишнего не добавляй.\n\n' + list;
    copy(prompt, q('#lk-aiprompt'));
    q('#lk-prev').innerHTML = '<div class="lp-row lp-ok">Запрос для ИИ скопирован (' + (PIECES || []).length + ' кусков). Отдай его ИИ, ответ вставь сюда в поле и нажми «разобрать».</div>';
  };
  q('#lk-apply').onclick = async () => {
    if(!parsed) return;
    q('#lk-apply').textContent = 'применяю…'; q('#lk-apply').disabled = true;
    parsed.createMissing = !q('#lk-missing') || q('#lk-missing').checked;
    const r = await applyLinks(parsed);
    try { PIECES = await fetch('/api/list').then(x => x.json()); FLOWS = await fetch('/api/flows/list').then(x => x.json()); } catch(_){}
    fillFilters(); renderPieces(); renderFlows();
    q('#lk-prev').innerHTML = '<div class="lp-row lp-ok">Готово: контрактов обновлено ' + r.contracts + ', ' + (r.merged ? 'дописано связей ' : 'связей ') + r.edges + (r.missing ? ', новых ящиков ' + r.missing : '') + (r.merged ? ' (в схеме всего ' + r.totalEdges + ')' : '') + (r.flowId ? ', схема сохранена' : '') + '.</div>';
    q('#lk-apply').style.display = 'none';
  };
}
document.getElementById('plinks').onclick = openLinksModal;

// ── отдельное окно: разложить куски по разделам ────────────────────────────────
const SECTIONS_SAMPLE = [
  '# Как разложить куски по разделам.',
  '# «раздел: Название» — начинает раздел. Подраздел — через «/».',
  '# Ниже — список кусков со значком «+» (имена как в Описи).',
  '',
  'раздел: Сеть / Запросы',
  '+ fetch + await — получить данные',
  '+ Парсер ответа API (columns/data)',
  '',
  'раздел: Сеть / Ошибки',
  '+ Запрос сломался — где и почему',
  '',
  'раздел: Математика / Статистика',
  '+ Среднее',
  '+ Сумма (reduce)'
].join('\n');
// разобрать только раздельную разметку → [{name, group}]
function parseSections(text){
  const items = [], errors = []; let section = '';
  String(text).split('\n').forEach((raw, i) => {
    const line = raw.trim(); const ln = i + 1;
    if(!line || line.startsWith('#') || line.startsWith('//')) return;
    let m;
    if((m = line.match(/^(?:раздел|группа|категория)[:\s]+(.+)/i))){ section = cleanName(m[1]); return; }
    if((m = line.match(/^\+\s*(.+)$/))){
      if(!section){ errors.push('строка ' + ln + ': «+ имя» без «раздел:» выше — «' + line + '»'); return; }
      items.push({ name: cleanName(m[1]), group: section, ln }); return;
    }
    // просто имя под заголовком раздела — тоже кладём (без «+»)
    if(section){ items.push({ name: cleanName(line), group: section, ln }); return; }
    errors.push('строка ' + ln + ': не понял — «' + line + '» (нет «раздел:» выше)');
  });
  return { items, errors };
}
function openSectionsModal(){
  const bg = el2('div', 'modal-bg');
  const box = el2('div', 'modal');
  box.innerHTML = '<h3>Разделы из текста</h3>'
    + '<p class="mh">Разложи куски по разделам. Пиши «<b>раздел: Название</b>», ниже — список кусков со значком «<b>+</b>». Подразделы — через «<b>/</b>» (напр. «Сеть / Запросы»). Имена — как в Описи, можно в «ёлочках».</p>'
    + '<div class="fmt">раздел: Сеть / Запросы&#10;+ fetch + await — получить данные&#10;+ Парсер ответа API (columns/data)&#10;&#10;раздел: Сеть / Ошибки&#10;+ Запрос сломался — где и почему</div>'
    + '<textarea id="sc-text" placeholder="вставь текст или нажми «пример»"></textarea>'
    + '<div class="mbtns"><button class="btn" id="sc-sample">пример</button><button class="btn ok" id="sc-parse">разобрать</button><button class="btn" id="sc-apply" style="display:none">применить</button><button class="btn" id="sc-close">закрыть</button></div>'
    + '<div class="lp-prev" id="sc-prev"></div>';
  bg.appendChild(box); document.body.appendChild(bg);
  const q = s => bg.querySelector(s);
  bg.onclick = e => { if(e.target === bg) bg.remove(); };
  q('#sc-close').onclick = () => bg.remove();
  q('#sc-sample').onclick = () => { q('#sc-text').value = SECTIONS_SAMPLE; };
  let parsed = null;
  q('#sc-parse').onclick = () => {
    parsed = parseSections(q('#sc-text').value);
    const prev = q('#sc-prev'); prev.innerHTML = '';
    const line = (txt, cls) => { const d = el2('div', 'lp-row ' + (cls || '')); d.textContent = txt; return d; };
    prev.appendChild(el2('div', 'lp-sec', 'в разделы (' + parsed.items.length + ')'));
    parsed.items.forEach(it => { const t = resolveName(it.name); prev.appendChild(line((t ? '✓ ' : '✕ ') + it.name + '  →  ' + it.group + (t ? '' : '  (кусок не найден)'), t ? 'lp-ok' : 'lp-bad')); });
    if(parsed.errors.length){ prev.appendChild(el2('div', 'lp-sec', 'не разобрано')); parsed.errors.forEach(x => prev.appendChild(line(x, 'lp-bad'))); }
    q('#sc-apply').style.display = parsed.items.some(it => resolveName(it.name)) ? '' : 'none';
  };
  q('#sc-apply').onclick = async () => {
    if(!parsed) return;
    q('#sc-apply').textContent = 'применяю…'; q('#sc-apply').disabled = true;
    let done = 0;
    for(const it of parsed.items){
      const t = resolveName(it.name); if(!t) continue;
      const r = await fetch('/api/edit', { method:'POST', body: JSON.stringify({ id: t.id, group: it.group }) }).then(r => r.json()).catch(() => ({}));
      if(r && r.ok){ t.group = it.group; done++; }
    }
    try { PIECES = await fetch('/api/list').then(x => x.json()); } catch(_){}
    fillFilters(); renderPieces();
    q('#sc-prev').innerHTML = '<div class="lp-row lp-ok">Готово: разложено кусков ' + done + '.</div>';
    q('#sc-apply').style.display = 'none';
  };
}
document.getElementById('psections').onclick = openSectionsModal;

// ── отдельное окно: массовое пополнение словаря пояснений ───────────────────────
const DICT_SAMPLE = [
  '# Пополнение словаря пояснений. Одна строка — одно слово.',
  '# Формат: слово: пояснение   (можно «слово = пояснение» или «слово | пояснение»)',
  '# Язык указывается в поле сверху (c, cpp, java…). Пусто — общий словарь.',
  '# Строки с # или // — комментарии.',
  '',
  'printf: printf — вывод в консоль в C: printf("%d", x). %d — число, %s — строка.',
  'malloc: malloc — выделить память вручную (C). Потом обязательно free().',
  'std::cout: std::cout — поток вывода в C++ (cout << x). Нужен #include <iostream>.',
  'System.out.println: System.out.println — печать строки с переводом строки в Java.',
  'public: public — модификатор доступа: виден отовсюду (C++/Java).'
].join('\n');
// разобрать строки «слово: пояснение» → [{word, text}]
// разбить строку «слово РАЗДЕЛИТЕЛЬ пояснение». Терпим к формату, чтобы большие списки не теряли строки:
// порядок разделителей — | , одиночное : (НЕ часть ::, иначе ломался std::cout), таб, « — »/« – », « = » (не ==/=>).
function splitDictLine(line){
  let k = line.indexOf('|'); if(k > 0) return [line.slice(0, k), line.slice(k + 1)];
  for(let i = 1; i < line.length; i++){ if(line[i] === ':' && line[i - 1] !== ':' && line[i + 1] !== ':') return [line.slice(0, i), line.slice(i + 1)]; }  // одиночное двоеточие
  k = line.indexOf('\t'); if(k > 0) return [line.slice(0, k), line.slice(k + 1)];
  let m = line.match(/\s[—–]\s/); if(m) return [line.slice(0, m.index), line.slice(m.index + m[0].length)];   // тире с пробелами
  m = line.match(/\s=\s/); if(m && line[m.index + 2] !== '=' && line[m.index + 2] !== '>') return [line.slice(0, m.index), line.slice(m.index + m[0].length)];  // « = », но не ==/=>
  return null;
}
// словарь описывает КОД: ключ должен быть код-токеном, а не русской фразой.
// Ловим две частые ошибки загрузки: (1) русский с каждой стороны — скорее перепутаны
// стороны или это вообще синонимы; (2) много запятых в пояснении — это список синонимов.
const _hasLatin = s => /[A-Za-z]/.test(s);
const _isRu = s => /[А-Яа-яЁё]/.test(s);
// пояснение-предложение (есть « — »/двоеточие или союзы) — это НЕ список синонимов
const _isSentenceC = s => /[—–:]/.test(String(s)) || /\b(если|когда|иначе|чтобы|потому|котор|это|нужно|значит|добавля|убира|возвраща|созда[её]т|вызыва|позволя|прове|делает)\b/i.test(String(s));
function parseDict(text){
  const entries = [], errors = [], suspicious = [], synLike = [], seen = new Set();
  String(text).split('\n').forEach((raw, i) => {
    const line = raw.trim(), ln = i + 1;
    if(!line || line.startsWith('#') || line.startsWith('//')) return;
    const pair = splitDictLine(line);
    if(!pair){ errors.push('строка ' + ln + ': нет разделителя (слово: пояснение) — «' + line + '»'); return; }
    const word = pair[0].trim(), expl = pair[1].trim();
    if(!word || !expl){ errors.push('строка ' + ln + ': пусто слово или пояснение — «' + line + '»'); return; }
    const key = word.toLowerCase();
    if(seen.has(key)) return;   // в самой вставке повтор — берём первый, молча (дедуп и так будет на сервере)
    seen.add(key);
    const e = { word, text: expl, ln };
    if(_isRu(word) && !_hasLatin(word)){ e.why = 'ключ на русском — это код описывают, слева должен быть код, а не фраза. Похоже, перепутаны стороны или это синонимы.'; suspicious.push(e); return; }
    if((expl.match(/,/g) || []).length >= 3 && !_isSentenceC(expl)){ e.why = 'в пояснении ' + ((expl.match(/,/g) || []).length) + ' запятых и нет связок — похоже на список синонимов, а не на пояснение.'; synLike.push(e); return; }
    entries.push(e);
  });
  return { entries, errors, suspicious, synLike };
}
function openDictModal(){
  const bg = el2('div', 'modal-bg');
  const box = el2('div', 'modal');
  box.innerHTML = '<h3>Словарь пояснений</h3>'
    + '<p class="mh">Бесконечно пополняй пояснения к особым словам <b>любого языка</b>. Укажи язык (c, cpp, java, python, rust, go…) — слова лягут в словарь этого языка и будут показываться, когда открыт файл на нём (в приоритете над общим). Пусто — общий словарь (для слов, общих всем языкам). Строка: <b>слово: пояснение</b> (или «=», или «|»). Всё попадает в <b>keyword-dict.json</b> — его читают песочница («пояснения», «🧩», «🔗»), автоподпись и бэкофилл.</p>'
    + '<div class="mbtns" style="margin-bottom:6px"><label class="inv-chk">язык: <input class="inv-search" id="dc-lang" list="dc-langs" placeholder="css, html, js, python, c, cpp… (пусто — общий, для всех языков)" style="width:260px"></label></div>'
    + '<datalist id="dc-langs">' + ((window.CODELAB_LANGS && window.CODELAB_LANGS.length) ? window.CODELAB_LANGS.map(l => l.v) : ['css','html','js','python']).filter(v => v !== 'txt').map(v => '<option value="' + v + '">').join('') + '</datalist>'
    + '<div class="lp-sec" style="margin:2px 0 4px">Шаг 1 (необязательно): собрать непонятные слова</div>'
    + '<p class="mh" style="margin:0 0 4px">Вставь код на этом языке (или оставь пусто — возьму куски этого языка из библиотеки). Соберу слова и устойчивые конструкции, которых ещё нет в словаре, склею повторы и дам готовый запрос — отдай его мне или GPT, ответ вставь в Шаг 2.</p>'
    + '<textarea id="dc-code" placeholder="код на этом языке (или выбери файл / оставь пусто — из библиотеки)" style="min-height:64px"></textarea>'
    + '<div class="mbtns"><button class="btn" id="dc-file">📄 из файла…</button><button class="btn" id="dc-scan">🔍 собрать непонятные слова</button><span class="pp-note" id="dc-scan-note"></span>'
    + '<input type="file" id="dc-fileinp" multiple style="display:none"></div>'
    + '<textarea id="dc-prompt" placeholder="сюда ляжет готовый запрос для ИИ" readonly style="min-height:64px;display:none"></textarea>'
    + '<div class="mbtns" id="dc-prompt-btns" style="display:none"><button class="btn" id="dc-copy">⧉ скопировать запрос</button></div>'
    + '<div class="lp-sec" style="margin:8px 0 4px">Шаг 2: добавить в словарь</div>'
    + '<div class="fmt">printf: printf — вывод в консоль в C&#10;malloc: выделить память вручную, потом free()&#10;std::cout: поток вывода в C++ (cout &lt;&lt; x)</div>'
    + '<textarea id="dc-text" placeholder="вставь строки «слово: пояснение» (ответ ИИ) или нажми «пример»"></textarea>'
    + '<div class="mbtns"><button class="btn" id="dc-sample">пример</button><button class="btn ok" id="dc-parse">разобрать</button><button class="btn" id="dc-apply" style="display:none">добавить в словарь</button><button class="btn" id="dc-close">закрыть</button></div>'
    + '<div class="lp-prev" id="dc-prev"></div>';
  bg.appendChild(box); document.body.appendChild(bg);
  const q = s => bg.querySelector(s);
  bg.onclick = e => { if(e.target === bg) bg.remove(); };
  q('#dc-close').onclick = () => bg.remove();
  q('#dc-sample').onclick = () => { q('#dc-text').value = DICT_SAMPLE; };
  // выбрать файл(ы): прочитать текст в поле кода, подставить язык по расширению и сразу собрать
  const EXT2LANG_FB = { c:'c', cpp:'cpp', java:'java', py:'python', js:'js', ts:'ts', html:'html', css:'css' };
  const extToLang = ext => window.langByExt ? window.langByExt(ext) : (EXT2LANG_FB[ext] || 'txt');
  q('#dc-file').onclick = () => q('#dc-fileinp').click();
  q('#dc-fileinp').onchange = async e => {
    const fs = [...(e.target.files || [])]; if(!fs.length) return;
    let text = '', ext = '';
    for(const f of fs){ try { text += (text ? '\n\n' : '') + await f.text(); } catch(_){} if(!ext){ ext = (f.name.split('.').pop() || '').toLowerCase(); } }
    q('#dc-code').value = text;
    if(!q('#dc-lang').value.trim()){ const l = extToLang(ext); if(l && l !== 'txt') q('#dc-lang').value = l; }
    e.target.value = '';
    q('#dc-scan').click();   // сразу собрать непонятные слова
  };
  // Шаг 1: собрать непонятные слова → готовый запрос для ИИ
  q('#dc-scan').onclick = async () => {
    const lang = q('#dc-lang').value.trim(), code = q('#dc-code').value;
    q('#dc-scan').textContent = 'собираю…'; q('#dc-scan').disabled = true; q('#dc-scan-note').textContent = '';
    const r = await fetch('/api/dict/unknown', { method: 'POST', body: JSON.stringify({ lang, code }) }).then(x => x.json()).catch(() => null);
    q('#dc-scan').textContent = '🔍 собрать непонятные слова'; q('#dc-scan').disabled = false;
    if(!r){ q('#dc-scan-note').textContent = 'ошибка'; return; }
    q('#dc-scan-note').textContent = 'непонятных: ' + r.count + (code ? '' : ' (просмотрено кусков: ' + r.scanned + ')');
    if(r.count){ q('#dc-prompt').value = r.prompt; q('#dc-prompt').style.display = ''; q('#dc-prompt-btns').style.display = ''; }
    else { q('#dc-prompt').style.display = 'none'; q('#dc-prompt-btns').style.display = 'none'; q('#dc-scan-note').textContent += ' — всё уже в словаре 👍'; }
  };
  q('#dc-copy').onclick = () => { const t = q('#dc-prompt'); t.select(); try { navigator.clipboard.writeText(t.value); } catch(_){ try { document.execCommand('copy'); } catch(e){} } q('#dc-copy').textContent = '✓ скопировано'; setTimeout(() => q('#dc-copy').textContent = '⧉ скопировать запрос', 1200); };
  let parsed = null;
  const renderDictPrev = () => {
    const prev = q('#dc-prev'); prev.innerHTML = '';
    const line = (txt, cls) => { const d = el2('div', 'lp-row ' + (cls || '')); d.textContent = txt; return d; };
    const hd = el2('div', 'lp-sec', 'разобрано слов: ' + parsed.entries.length + (parsed.errors.length ? '  ·  ⚠ НЕ разобрано: ' + parsed.errors.length + ' (ниже — поправь и вставь снова)' : ''));
    if(parsed.errors.length) hd.style.color = '#ffb454';
    prev.appendChild(hd);
    parsed.entries.slice(0, 200).forEach(e => prev.appendChild(line('✓ ' + e.word + '  →  ' + e.text.slice(0, 80), 'lp-ok')));
    if(parsed.entries.length > 200) prev.appendChild(line('…и ещё ' + (parsed.entries.length - 200) + ' (все добавятся, тут показаны первые 200)', 'muted'));
    // 🟡 похоже на синонимы (много запятых) — предлагаем перенос в синонимы
    if(parsed.synLike.length){
      const s = el2('div', 'lp-sec', '🟡 похоже на синонимы (' + parsed.synLike.length + ') — пояснение-список через запятые. Это ищется по смыслу, место им в синонимах:');
      s.style.color = '#ffb454'; prev.appendChild(s);
      parsed.synLike.forEach(e => prev.appendChild(line('≈ ' + e.word + '  →  ' + e.text.slice(0, 80), 'lp-bad')));
      const bt = el2('div', 'mbtns');
      const mv = el2('button', 'btn ok', '🔤 перенести ' + parsed.synLike.length + ' в синонимы');
      mv.onclick = async () => {
        mv.textContent = 'переношу…'; mv.disabled = true;
        const ents = parsed.synLike.map(e => [e.word, e.text]);
        const r = await fetch('/api/dict/synonyms', { method: 'POST', body: JSON.stringify({ entries: ents }) }).then(x => x.json()).catch(() => ({}));
        if(r && r.ok){ parsed.synLike = []; renderDictPrev(); const d = el2('div', 'lp-row lp-ok', 'Перенесено в синонимы: терминов ' + r.terms + ', фраз ' + r.added + '. Обнови песочницу (Ctrl+F5).'); prev.appendChild(d); }
        else { mv.textContent = '🔤 перенести в синонимы'; mv.disabled = false; prev.appendChild(el2('div', 'lp-row lp-bad', 'не удалось перенести')); }
      };
      const keep = el2('button', 'btn', 'всё равно в словарь');
      keep.onclick = () => { parsed.entries = parsed.entries.concat(parsed.synLike); parsed.synLike = []; renderDictPrev(); };
      bt.appendChild(mv); bt.appendChild(keep); prev.appendChild(bt);
    }
    // 🔴 русский с каждой стороны — ключ-фраза. В словарь по умолчанию НЕ кладём
    if(parsed.suspicious.length){
      const s = el2('div', 'lp-sec', '🔴 ключ на русском (' + parsed.suspicious.length + ') — слева фраза, а не код. Скорее перепутаны стороны или это синонимы. Не добавлю, пока не подтвердишь:');
      s.style.color = '#ff6b8a'; prev.appendChild(s);
      parsed.suspicious.forEach(e => prev.appendChild(line('⚠ ' + e.word + '  →  ' + e.text.slice(0, 80), 'lp-bad')));
      const bt = el2('div', 'mbtns');
      const force = el2('button', 'btn', 'всё равно добавить в словарь');
      force.onclick = () => { parsed.entries = parsed.entries.concat(parsed.suspicious); parsed.suspicious = []; renderDictPrev(); };
      bt.appendChild(force); prev.appendChild(bt);
    }
    if(parsed.errors.length){ prev.appendChild(el2('div', 'lp-sec', '⚠ не разобрано (эти строки НЕ добавятся):')); parsed.errors.forEach(x => prev.appendChild(line(x, 'lp-bad'))); }
    q('#dc-apply').style.display = parsed.entries.length ? '' : 'none';
  };
  q('#dc-parse').onclick = () => { parsed = parseDict(q('#dc-text').value); renderDictPrev(); };
  q('#dc-apply').onclick = async () => {
    if(!parsed || !parsed.entries.length) return;
    q('#dc-apply').textContent = 'добавляю…'; q('#dc-apply').disabled = true;
    const lang = q('#dc-lang').value.trim();
    const r = await fetch('/api/dict/add', { method: 'POST', body: JSON.stringify({ lang, entries: parsed.entries }) }).then(x => x.json()).catch(() => ({}));
    q('#dc-prev').innerHTML = '<div class="lp-row ' + (r && r.ok ? 'lp-ok' : 'lp-bad') + '">' + (r && r.ok ? ('Готово: добавлено ' + r.added + ' в ' + (r.where || 'словарь') + ' (всего там ' + r.total + '). Обнови страницу песочницы (Ctrl+F5), чтобы подхватилось.') : 'Ошибка сохранения') + '</div>';
    q('#dc-apply').style.display = 'none';
  };
}
document.getElementById('pdict').onclick = openDictModal;

// ── отдельное окно: весь словарь пояснений (перечень описанного синтаксиса) ──────
function openDictViewModal(){
  const bg = el2('div', 'modal-bg');
  const box = el2('div', 'modal');
  box.innerHTML = '<h3>Весь словарь пояснений</h3>'
    + '<p class="mh">Всё описанное — из <b>keyword-dict.json</b>. Разделы: общее/код, по языкам (c, cpp, java…), HTML-теги/атрибуты, CSS-свойства/значения. Поиск фильтрует по слову и тексту. «⧉» у раздела копирует его строками «слово: пояснение».</p>'
    + '<input class="inv-search" id="dv-q" placeholder="поиск по слову или пояснению…" style="width:100%;box-sizing:border-box;margin-bottom:8px">'
    + '<div id="dv-groups" style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px"></div>'
    + '<div class="mbtns"><button class="btn" id="dv-close">закрыть</button><button class="btn" id="dv-audit" title="проверить то, что уже загружено: русские ключи, пояснения-списки (синонимы), куски без кода — и починить на месте">🩺 проверка мест</button><button class="btn" id="dv-dups" title="найти ключи, лежащие сразу в нескольких разделах/языках">🔍 дубли</button><button class="btn" id="dv-clean" title="убрать обрывки кода: ключи с несбалансированными скобками — это куски строк, а не термины">🧹 обрывки кода</button><span class="pp-note" id="dv-note" style="margin-left:auto"></span></div>'
    + '<div class="lp-prev" id="dv-dupbox" style="display:none;max-height:28vh;margin-bottom:8px;border-color:#b45cff"></div>'
    + '<div class="lp-prev" id="dv-body" style="max-height:60vh"></div>';
  bg.appendChild(box); document.body.appendChild(bg);
  const q = s => bg.querySelector(s);
  bg.onclick = e => { if(e.target === bg) bg.remove(); };
  q('#dv-close').onclick = () => bg.remove();

  let dict = null;
  const SECTS = [['words', 'Общее / код'], ['htmlTags', 'HTML-теги'], ['htmlAttrs', 'HTML-атрибуты'], ['cssProps', 'CSS-свойства'], ['cssVals', 'CSS-значения']];
  const copy = text => { try { navigator.clipboard.writeText(text); } catch(_){ const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch(e){} t.remove(); } };

  // привязать/снять кусок-пример к термину
  async function setExample(term, piece){
    const r = await fetch('/api/dict/example', { method: 'POST', body: JSON.stringify({ term, piece }) }).then(x => x.json()).catch(() => null);
    if(r && r.ok){ dict.examples = dict.examples || {}; const k = term.toLowerCase(); if(r.example) dict.examples[k] = r.example; else delete dict.examples[k]; render(); }
    else alert(r && r.error ? r.error : 'не удалось привязать пример');
  }
  // показать/скрыть код куска-примера под строкой
  async function toggleCode(rowEl, id){
    const nx = rowEl.nextSibling; if(nx && nx.__code){ nx.remove(); return; }
    const t = await fetch('/api/template?id=' + encodeURIComponent(id)).then(x => x.json()).catch(() => null);
    const code = t ? (t.code != null ? t.code : (Array.isArray(t.lines) ? t.lines.map(l => (l || []).map(k => k.v != null ? k.v : '').join('')).join('\n') : '')) : '(не загрузилось)';
    const pre = document.createElement('pre'); pre.__code = true; pre.textContent = code;
    pre.style.cssText = 'background:var(--code-bg,#0e0720);border:1px solid var(--border,#3a2f55);border-radius:7px;padding:8px;margin:2px 0 6px;font:11.5px/1.4 monospace;white-space:pre-wrap;max-height:220px;overflow:auto';
    rowEl.after(pre);
  }

  let activeGroup = null;   // null = показывать все разделы; иначе — только выбранный (клик по чипу)
  function render(){
    const body = q('#dv-body'); body.innerHTML = '';
    if(!dict){ body.textContent = 'загрузка…'; return; }
    const flt = (q('#dv-q').value || '').trim().toLowerCase();
    // собрать разделы: языки первыми. HTML и CSS — ЕДИНЫЕ разделы: базовые секции (теги/атрибуты,
    // свойства/значения из стартового seed) + языковой файл html.json/css.json вместе, иначе «3 вида HTML».
    const groups = [];
    const htmlMerged = Object.assign({}, dict.htmlTags || {}, dict.htmlAttrs || {}, (dict.langs && dict.langs.html) || {});
    const cssMerged = Object.assign({}, dict.cssProps || {}, dict.cssVals || {}, (dict.langs && dict.langs.css) || {});
    if(Object.keys(htmlMerged).length) groups.push(['html', htmlMerged]);
    if(Object.keys(cssMerged).length) groups.push(['css', cssMerged]);
    if(dict.langs) for(const lang of Object.keys(dict.langs).sort()){ if(lang === 'html' || lang === 'css') continue; if(Object.keys(dict.langs[lang] || {}).length) groups.push(['Язык: ' + lang, dict.langs[lang]]); }
    if(dict.words && Object.keys(dict.words).length) groups.push(['Общее / код', dict.words]);
    // чипы-разделы сверху: видно, что языки есть, и можно показать только нужный
    const chips = q('#dv-groups'); chips.innerHTML = '';
    const chip = (label, on, onClick) => { const b = el2('button', 'btn'); b.textContent = label; b.style.cssText = 'padding:2px 10px;border-radius:12px;font-size:11.5px' + (on ? ';background:var(--acc,#52F2C9);color:#06231c' : ''); b.onclick = onClick; return b; };
    chips.appendChild(chip('всё (' + groups.reduce((s, [, o]) => s + Object.keys(o).length, 0) + ')', !activeGroup, () => { activeGroup = null; render(); }));
    groups.forEach(([title, obj]) => chips.appendChild(chip(title.replace('Язык: ', '') + ' (' + Object.keys(obj).length + ')', activeGroup === title, () => { activeGroup = title; render(); })));
    let total = 0, shown = 0;
    groups.forEach(([title, obj]) => {
      if(activeGroup && title !== activeGroup){ total += Object.keys(obj).length; return; }   // показываем только выбранный раздел, но «всего» считаем по всем
      const rows = Object.entries(obj).filter(([w, t]) => !flt || w.toLowerCase().includes(flt) || String(t).toLowerCase().includes(flt));
      total += Object.keys(obj).length; shown += rows.length;
      if(!rows.length) return;
      const head = el2('div', 'lp-sec'); head.style.display = 'flex'; head.style.alignItems = 'center'; head.style.gap = '8px';
      head.appendChild(document.createTextNode(title + ' (' + rows.length + (flt ? ' из ' + Object.keys(obj).length : '') + ')'));
      const cp = el2('button', 'btn'); cp.textContent = '⧉'; cp.title = 'скопировать раздел строками «слово: пояснение»'; cp.style.marginLeft = 'auto'; cp.style.padding = '1px 8px';
      cp.onclick = () => { copy(rows.map(([w, t]) => w + ': ' + t).join('\n')); cp.textContent = '✓'; setTimeout(() => cp.textContent = '⧉', 1000); };
      head.appendChild(cp); body.appendChild(head);
      // внутри раздела делим на конструкции (многословные ключи) и одиночные слова
      const isCon = k => !/^[a-z0-9_$-]+$/i.test(k);
      const sorted = rows.slice().sort((a, b) => a[0].localeCompare(b[0]));
      const cons = sorted.filter(([w]) => isCon(w)), words = sorted.filter(([w]) => !isCon(w));
      const renderRow = ([w, t]) => {
        const d = el2('div', 'lp-row'); d.style.display = 'flex'; d.style.alignItems = 'baseline'; d.style.gap = '6px'; d.style.flexWrap = 'wrap';
        const b = document.createElement('b'); b.textContent = w; b.style.color = 'var(--name,#cbc2ea)'; b.style.flex = 'none'; d.appendChild(b);
        const tx = document.createElement('span'); tx.textContent = ' — ' + t; tx.style.flex = '1'; tx.style.minWidth = '120px'; d.appendChild(tx);
        const ctl = document.createElement('span'); ctl.style.cssText = 'font-size:11px;white-space:nowrap';
        const ex = dict.examples && dict.examples[w];
        if(ex){
          const lnk = el2('button', 'btn'); lnk.style.padding = '0 6px'; lnk.textContent = '▶ ' + (ex.title || ex.id); lnk.title = 'показать код примера'; lnk.onclick = () => toggleCode(d, ex.id);
          const rm = el2('button', 'btn'); rm.style.padding = '0 6px'; rm.textContent = '✕'; rm.title = 'снять пример'; rm.onclick = () => setExample(w, '');
          ctl.append(lnk, rm);
        } else {
          const add = el2('button', 'btn'); add.style.padding = '0 6px'; add.textContent = '＋ пример'; add.title = 'привязать кусок-пример'; add.onclick = () => { const p = prompt('Название или id куска-примера для «' + w + '»:'); if(p && p.trim()) setExample(w, p.trim()); };
          ctl.appendChild(add);
        }
        d.appendChild(ctl); body.appendChild(d);
      };
      if(cons.length){ const sub = el2('div', 'muted'); sub.style.cssText = 'font-size:11px;margin:3px 0 1px 6px'; sub.textContent = '— конструкции (' + cons.length + ')'; body.appendChild(sub); cons.forEach(renderRow); }
      if(words.length){ if(cons.length){ const sub = el2('div', 'muted'); sub.style.cssText = 'font-size:11px;margin:5px 0 1px 6px'; sub.textContent = '— слова (' + words.length + ')'; body.appendChild(sub); } words.forEach(renderRow); }
    });
    q('#dv-note').textContent = 'всего: ' + total + (flt ? ' · найдено: ' + shown : '');
    if(!shown) body.appendChild(el2('div', 'lp-row muted', flt ? 'ничего не найдено' : 'словарь пуст'));
  }
  // проверка дублей: один и тот же ключ в нескольких разделах/языках (внутри одного раздела дублей быть не может — объект по ключу)
  function showDups(){
    const panel = q('#dv-dupbox');
    if(panel.style.display !== 'none' && !panel.__audit){ panel.style.display = 'none'; return; }
    panel.style.display = ''; panel.__audit = false; panel.innerHTML = '';
    if(!dict){ panel.textContent = 'словарь ещё не загружен'; return; }
    const where = new Map();
    // html-теги/атрибуты и язык html — одно ведро «html» (то же для css), иначе единый раздел HTML светится как «дубль»
    const bucket = { htmlTags: 'html', htmlAttrs: 'html', cssProps: 'css', cssVals: 'css', words: 'общее' };
    const scan = (obj, label) => { if(!obj) return; for(const k of Object.keys(obj)){ const kk = k.toLowerCase(); if(!where.has(kk)) where.set(kk, new Set()); where.get(kk).add(label); } };
    SECTS.forEach(([key]) => scan(dict[key], bucket[key] || key));
    if(dict.langs) for(const lang of Object.keys(dict.langs)) scan(dict.langs[lang], lang === 'html' || lang === 'css' ? lang : 'язык: ' + lang);
    const dups = [...where].map(([k, set]) => [k, [...set]]).filter(([, src]) => src.length > 1).sort((a, b) => a[0].localeCompare(b[0]));
    const head = el2('div', 'lp-sec'); head.textContent = dups.length ? ('Ключи в нескольких местах: ' + dups.length) : 'Дублей нет — каждый ключ ровно в одном разделе'; panel.appendChild(head);
    if(dups.length){
      const note = el2('div', 'muted'); note.style.cssText = 'font-size:11px;margin:0 0 4px 6px'; note.textContent = 'при клике по слову в коде побеждает язык (его пояснение). Общие строки можно оставить или убрать из общего раздела.'; panel.appendChild(note);
      dups.forEach(([k, src]) => { const d = el2('div', 'lp-row'); const b = document.createElement('b'); b.textContent = k; b.style.color = 'var(--name,#cbc2ea)'; d.appendChild(b); d.appendChild(document.createTextNode(' → ' + src.join(', '))); panel.appendChild(d); });
    }
  }
  q('#dv-dups').onclick = showDups;
  // ревизия «на своём ли месте»: проходим по уже загруженному и чиним точечно
  const reloadDict = () => { dict = null; fetch('/keyword-dict.json', { cache: 'no-store' }).then(x => x.json()).then(d => { dict = d; render(); }).catch(() => {}); };
  q('#dv-audit').onclick = async () => {
    const panel = q('#dv-dupbox');
    if(panel.style.display !== 'none' && panel.__audit){ panel.style.display = 'none'; panel.__audit = false; return; }
    panel.style.display = ''; panel.__audit = true; panel.innerHTML = 'проверяю загруженное…';
    const r = await fetch('/api/dict/audit', { method: 'POST', body: JSON.stringify({}) }).then(x => x.json()).catch(() => null);
    panel.innerHTML = '';
    if(!r || !r.ok){ panel.textContent = 'не удалось проверить'; return; }
    const c = r.counts;
    if(!c.ruKeys && !c.synLike && !c.prosePieces){ panel.appendChild(el2('div', 'lp-sec', 'Всё на своих местах ✓ — перепутанного не нашлось')); return; }
    panel.appendChild(el2('div', 'lp-sec', 'Кандидаты «не на своём месте»: русских ключей ' + c.ruKeys + ' · пояснений-списков ' + c.synLike + ' · кусков без кода ' + c.prosePieces));
    const warn = el2('div', 'muted'); warn.style.cssText = 'font-size:11px;margin:0 0 4px 6px'; warn.textContent = 'Это подсказки, а не приговор: часть русских ключей — твой глоссарий понятий/ошибок (так и задумано). Смотри сама, удаляй только лишнее. Ничего не удаляю без подтверждения.'; panel.appendChild(warn);
    const mk = (txt, cls) => { const d = el2('div', 'lp-row ' + (cls || '')); d.textContent = txt; return d; };
    const btnrow = () => el2('div', 'mbtns');
    // 🟡 пояснения-списки = синонимы: переносим в синонимы и убираем из словаря
    if(r.synLike.length){
      const s = el2('div', 'lp-sec', '🟡 пояснение — список через запятые (' + r.synLike.length + '): это синонимы, им место в поиске по смыслу'); s.style.color = '#ffb454'; panel.appendChild(s);
      r.synLike.slice(0, 40).forEach(e => panel.appendChild(mk('[' + e.where + '] ' + e.key + '  →  ' + e.text, 'lp-bad')));
      if(r.synLike.length > 40) panel.appendChild(mk('…и ещё ' + (r.synLike.length - 40), 'muted'));
      const row = btnrow();
      const cps = el2('button', 'btn', '⧉ скопировать');
      cps.onclick = () => { copy(r.synLike.map(e => e.key + ': ' + e.text).join('\n')); cps.textContent = '✓'; setTimeout(() => cps.textContent = '⧉ скопировать', 1000); };
      const mv = el2('button', 'btn ok', '🔤 перенести все ' + r.synLike.length + ' в синонимы');
      mv.onclick = async () => { if(!confirm('Перенести ' + r.synLike.length + ' в синонимы и убрать из словаря? Пояснения станут фразами для поиска по смыслу.')) return;
        mv.textContent = 'переношу…'; mv.disabled = true;
        const syn = r.synLike.map(e => [e.key, e.text]);
        const a = await fetch('/api/dict/synonyms', { method: 'POST', body: JSON.stringify({ entries: syn }) }).then(x => x.json()).catch(() => ({}));
        if(a && a.ok){ await fetch('/api/dict/remove', { method: 'POST', body: JSON.stringify({ entries: r.synLike.map(e => ({ where: e.where, key: e.key })) }) }).then(x => x.json()).catch(() => ({}));
          r.synLike = []; reloadDict(); mv.replaceWith(mk('✓ перенесено в синонимы: терминов ' + a.terms + ', фраз ' + a.added, 'lp-ok')); }
        else { mv.textContent = '🔤 перенести в синонимы'; mv.disabled = false; }
      };
      row.append(cps, mv); panel.appendChild(row);
    }
    // 🔴 русский ключ: слева фраза, а не код. Чистим из словаря (пояснения грузят с кодом-ключом)
    if(r.ruKeys.length){
      const s = el2('div', 'lp-sec', '🔴 ключ на русском (' + r.ruKeys.length + '): слева должен быть код, а не фраза. Перепутаны стороны или это синонимы'); s.style.color = '#ff6b8a'; panel.appendChild(s);
      r.ruKeys.slice(0, 40).forEach(e => panel.appendChild(mk('[' + e.where + '] ' + e.key + '  →  ' + e.text, 'lp-bad')));
      if(r.ruKeys.length > 40) panel.appendChild(mk('…и ещё ' + (r.ruKeys.length - 40), 'muted'));
      const row = btnrow();
      const cp = el2('button', 'btn', '⧉ скопировать (чтобы перезалить правильно)');
      cp.onclick = () => { copy(r.ruKeys.map(e => e.key + ': ' + e.text).join('\n')); cp.textContent = '✓ скопировано'; setTimeout(() => cp.textContent = '⧉ скопировать (чтобы перезалить правильно)', 1200); };
      const del = el2('button', 'btn', '🗑 убрать все ' + r.ruKeys.length + ' из словаря');
      del.onclick = async () => { if(!confirm('Убрать ' + r.ruKeys.length + ' русских ключей из словаря? Скопируй их сначала, если нужно перезалить.')) return;
        del.textContent = 'убираю…'; del.disabled = true;
        const a = await fetch('/api/dict/remove', { method: 'POST', body: JSON.stringify({ entries: r.ruKeys.map(e => ({ where: e.where, key: e.key })) }) }).then(x => x.json()).catch(() => ({}));
        if(a && a.ok){ r.ruKeys = []; reloadDict(); del.replaceWith(mk('✓ убрано из словаря: ' + a.removed + '. Не забудь синхронизацию.', 'lp-ok')); }
        else { del.textContent = '🗑 убрать из словаря'; del.disabled = false; }
      };
      row.append(cp, del); panel.appendChild(row);
    }
    // 🧩 куски без кода: «код» это русский текст
    if(r.prosePieces.length){
      const s = el2('div', 'lp-sec', '🧩 куски без кода (' + r.prosePieces.length + '): в коде русский текст — это словарь/синонимы загрузили как кусок'); s.style.color = '#ff6b8a'; panel.appendChild(s);
      r.prosePieces.forEach(p => panel.appendChild(mk('[' + (p.lang || '?') + '] ' + p.title + '  —  ' + p.code, 'lp-bad')));
      const row = btnrow();
      const del = el2('button', 'btn', '🗑 удалить все ' + r.prosePieces.length + ' куска');
      del.onclick = async () => { if(!confirm('Удалить ' + r.prosePieces.length + ' кусков, где код — русский текст?')) return;
        del.textContent = 'удаляю…'; del.disabled = true; let n = 0;
        for(const p of r.prosePieces){ const a = await fetch('/api/delete', { method: 'POST', body: JSON.stringify({ id: p.id }) }).then(x => x.json()).catch(() => null); if(a) n++; }
        r.prosePieces = []; del.replaceWith(mk('✓ удалено кусков: ' + n + '. Не забудь синхронизацию.', 'lp-ok'));
      };
      row.appendChild(del); panel.appendChild(row);
    }
  };
  // чистка обрывков кода: показать найденное → подтвердить удаление
  q('#dv-clean').onclick = async () => {
    const panel = q('#dv-dupbox'); panel.style.display = ''; panel.__audit = false; panel.innerHTML = 'ищу обрывки кода…';
    const r = await fetch('/api/dict/clean', { method: 'POST', body: JSON.stringify({ apply: false }) }).then(x => x.json()).catch(() => null);
    panel.innerHTML = '';
    if(!r || !r.ok){ panel.textContent = 'не удалось проверить'; return; }
    if(!r.count){ panel.appendChild(el2('div', 'lp-sec', 'Обрывков кода не найдено — словарь чистый ✓')); return; }
    panel.appendChild(el2('div', 'lp-sec', 'Обрывки кода (несбалансированные скобки): ' + r.count));
    const note = el2('div', 'muted'); note.style.cssText = 'font-size:11px;margin:0 0 4px 6px'; note.textContent = 'это куски строк, а не термины. Нормальные конструкции (сбалансированные) не тронутся. Примеры:'; panel.appendChild(note);
    r.sample.forEach(x => { const d = el2('div', 'lp-row'); const b = document.createElement('b'); b.textContent = x.where; b.style.cssText = 'color:var(--muted,#9a93b5);font-size:10px;margin-right:6px'; d.appendChild(b); d.appendChild(document.createTextNode(x.key.slice(0, 70))); panel.appendChild(d); });
    const go = el2('button', 'btn ok'); go.textContent = 'удалить ' + r.count; go.style.marginTop = '6px';
    go.onclick = async () => { go.textContent = 'удаляю…'; go.disabled = true; const rr = await fetch('/api/dict/clean', { method: 'POST', body: JSON.stringify({ apply: true }) }).then(x => x.json()).catch(() => null); if(rr && rr.ok){ panel.innerHTML = '<div class="lp-row lp-ok">Удалено: ' + rr.removed + '. Не забудь синхронизацию, чтобы чистка уехала в репозиторий.</div>'; dict = null; fetch('/keyword-dict.json', { cache: 'no-store' }).then(x => x.json()).then(d => { dict = d; render(); }); } else panel.innerHTML = '<div class="lp-row lp-bad">ошибка удаления</div>'; };
    panel.appendChild(go);
  };
  q('#dv-q').addEventListener('input', render);
  render();
  fetch('/keyword-dict.json', { cache: 'no-store' }).then(r => r.json()).then(d => { dict = d; render(); }).catch(() => { q('#dv-body').textContent = 'не удалось загрузить словарь'; });
}
document.getElementById('pdictview').onclick = openDictViewModal;

// ── окно: синонимы для поиска по смыслу (найти термин, не помня имени) ───────────
function openSynModal(){
  const bg = el2('div', 'modal-bg');
  const box = el2('div', 'modal');
  box.innerHTML = '<h3>Синонимы для поиска</h3>'
    + '<p class="mh">Чтобы находить термин по смыслу, когда не помнишь имя. Строка: <b>термин: синоним, фраза, ещё…</b> (синонимы через запятую). Пример: <code>console.log: вывод в консоль, печать, показать в консоли</code> или <code>.map: перебор массива, преобразовать каждый элемент</code>. Эти фразы ищет единый поиск в песочнице (фильтр «словарь») и находит нужный термин.</p>'
    + '<div class="fmt">console.log: вывод в консоль, печать&#10;.map: перебор массива, преобразовать каждый&#10;try/catch: поймать ошибку, обработка исключений&#10;padding: внутренний отступ, поля внутри</div>'
    + '<textarea id="sy-text" placeholder="термин: синоним, фраза, ещё синоним" style="min-height:140px"></textarea>'
    + '<div class="mbtns"><button class="btn" id="sy-sample">пример</button><button class="btn ok" id="sy-parse">разобрать</button><button class="btn" id="sy-apply" style="display:none">добавить</button><button class="btn" id="sy-view">показать текущие</button><button class="btn" id="sy-close">закрыть</button></div>'
    + '<div class="lp-prev" id="sy-prev"></div>';
  bg.appendChild(box); document.body.appendChild(bg);
  const q = s => bg.querySelector(s);
  bg.onclick = e => { if(e.target === bg) bg.remove(); };
  q('#sy-close').onclick = () => bg.remove();
  q('#sy-sample').onclick = () => { q('#sy-text').value = 'console.log: вывод в консоль, печать\n.map: перебор массива, преобразовать каждый\ntry/catch: поймать ошибку, обработка исключений'; };
  // парсер: «термин: синонимы» (тот же splitDictLine, что и у словаря)
  let parsed = null;
  q('#sy-parse').onclick = () => {
    const entries = [], errors = []; const seen = new Set();
    String(q('#sy-text').value).split('\n').forEach((raw, i) => {
      const line = raw.trim(); if(!line || line.startsWith('#') || line.startsWith('//')) return;
      const pair = splitDictLine(line);
      if(!pair){ errors.push('строка ' + (i + 1) + ': нет разделителя (термин: синонимы) — «' + line + '»'); return; }
      const term = pair[0].trim().toLowerCase(), rest = pair[1].trim();
      if(!term || !rest){ errors.push('строка ' + (i + 1) + ': пусто'); return; }
      if(seen.has(term)) return; seen.add(term);
      entries.push([term, rest]);
    });
    parsed = { entries, errors };
    const prev = q('#sy-prev'); prev.innerHTML = '';
    const hd = el2('div', 'lp-sec', 'терминов: ' + entries.length + (errors.length ? '  ·  ⚠ не разобрано: ' + errors.length : '')); if(errors.length) hd.style.color = '#ffb454'; prev.appendChild(hd);
    entries.slice(0, 200).forEach(([t, r]) => { const d = el2('div', 'lp-row lp-ok'); d.textContent = '✓ ' + t + '  →  ' + r; prev.appendChild(d); });
    errors.forEach(x => prev.appendChild(el2('div', 'lp-row lp-bad', x)));
    q('#sy-apply').style.display = entries.length ? '' : 'none';
  };
  q('#sy-apply').onclick = async () => {
    if(!parsed || !parsed.entries.length) return;
    q('#sy-apply').textContent = 'добавляю…'; q('#sy-apply').disabled = true;
    const r = await fetch('/api/dict/synonyms', { method: 'POST', body: JSON.stringify({ entries: parsed.entries }) }).then(x => x.json()).catch(() => ({}));
    q('#sy-prev').innerHTML = '<div class="lp-row ' + (r && r.ok ? 'lp-ok' : 'lp-bad') + '">' + (r && r.ok ? ('Готово: терминов затронуто ' + r.terms + ', новых синонимов ' + r.added + ' (всего терминов с синонимами ' + r.totalTerms + '). Не забудь синхронизацию. Обнови песочницу (Ctrl+F5).') : 'Ошибка сохранения') + '</div>';
    q('#sy-apply').style.display = 'none'; q('#sy-apply').textContent = 'добавить'; q('#sy-apply').disabled = false;
  };
  q('#sy-view').onclick = async () => {
    const prev = q('#sy-prev'); prev.innerHTML = 'загрузка…';
    const d = await fetch('/keyword-dict.json', { cache: 'no-store' }).then(x => x.json()).catch(() => null);
    prev.innerHTML = '';
    const syn = (d && d.synonyms) || {}; const keys = Object.keys(syn).sort();
    prev.appendChild(el2('div', 'lp-sec', 'Текущие синонимы: ' + keys.length + ' терминов'));
    if(!keys.length){ prev.appendChild(el2('div', 'lp-row muted', 'пока пусто')); return; }
    keys.forEach(t => { const d2 = el2('div', 'lp-row'); const b = document.createElement('b'); b.textContent = t; b.style.color = 'var(--name,#cbc2ea)'; d2.appendChild(b); d2.appendChild(document.createTextNode(' — ' + (syn[t] || []).join(', '))); prev.appendChild(d2); });
  };
}
document.getElementById('pdictsyn').onclick = openSynModal;

