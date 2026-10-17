// Опись: полные списки кусочков кода и схем со связями, с копированием.
let PIECES = [], FLOWS = [];

(async function(){
  try { PIECES = await fetch('/api/list').then(r => r.json()); } catch(_){ PIECES = []; }
  try { FLOWS = await fetch('/api/flows/list').then(r => r.json()); } catch(_){ FLOWS = []; }
  const leg = document.getElementById('covLegend');
  if(leg) leg.innerHTML = 'Описано: ' + [['inputs','Вх','Входы'],['outputs','Вых','Выходы'],['env','Ср','Среда'],['pre','Пр','Предусловия'],['effects','Эф','Побочные эффекты'],['errors','Ош','Ошибки'],['links','Св','Связи'],['check','Пв','Проверка']].map(f => '<span><b>' + f[1] + '</b> — ' + f[2] + '</span>').join('');
  renderPieces(); renderFlows();
})();

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
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

function pieceRows(list){
  return list.map(t => {
    const g = give(t), n = need(t);
    return '<tr data-id="' + esc(t.id) + '">'
      + '<td class="t-title"><a href="/component.html?id=' + encodeURIComponent(t.id) + '">' + esc(t.title || t.id) + '</a><div class="t-id">' + esc(t.id) + '</div></td>'
      + '<td>' + esc((t.lang || '').toUpperCase()) + '</td>'
      + '<td>' + esc(t.group || '') + '</td>'
      + '<td class="give edit-cell" data-field="provides" title="клик — изменить">' + (g.length ? esc(g.join(', ')) : '<span class="muted">+ отметить</span>') + '</td>'
      + '<td class="need edit-cell" data-field="requires" title="клик — изменить">' + (n.length ? esc(n.join(', ')) : '<span class="muted">+ отметить</span>') + '</td>'
      + '<td>' + covCell(t) + '</td>'
      + '</tr>';
  }).join('');
}
// инлайн-редактирование ячеек «даёт/нужно»
document.getElementById('prows').addEventListener('click', e => {
  const cell = e.target.closest && e.target.closest('.edit-cell'); if(!cell) return;
  if(cell.querySelector('input')) return;
  const id = cell.parentElement.dataset.id, field = cell.dataset.field;
  const t = PIECES.find(x => x.id === id); if(!t) return;
  const cur = (field === 'provides' ? give(t) : need(t)).join(', ');
  cell.innerHTML = '<input class="inv-cell-in" value="' + esc(cur) + '" placeholder="имена через запятую">';
  const inp = cell.querySelector('input'); inp.focus(); inp.select();
  const save = async () => {
    const vals = inp.value.split(',').map(s => s.trim()).filter(Boolean);
    const r = await fetch('/api/edit', { method:'POST', body: JSON.stringify({ id, [field]: vals }) }).then(r => r.json()).catch(() => ({}));
    if(r && r.ok){ t.comp = t.comp || {}; t.comp[field] = vals; }
    renderPieces();
  };
  inp.addEventListener('blur', save, { once: true });
  inp.addEventListener('keydown', ev => { if(ev.key === 'Enter'){ ev.preventDefault(); inp.blur(); } if(ev.key === 'Escape'){ inp.removeEventListener('blur', save); renderPieces(); } });
});
function filteredPieces(){
  const q = (document.getElementById('pq').value || '').toLowerCase().trim();
  const incompleteOnly = document.getElementById('pincomplete') && document.getElementById('pincomplete').checked;
  let list = PIECES;
  if(q) list = list.filter(t => ((t.title || '') + ' ' + (t.id || '') + ' ' + (t.group || '') + ' ' + give(t).join(' ') + ' ' + need(t).join(' ')).toLowerCase().includes(q));
  if(incompleteOnly) list = list.filter(t => covCount(t) < FACETS.length);
  return list;
}
function renderPieces(){
  const list = filteredPieces();
  document.getElementById('prows').innerHTML = list.length ? pieceRows(list) : '<tr><td colspan="5" class="empty">ничего не нашлось</td></tr>';
  document.getElementById('pcnt').textContent = list.length + (list.length === PIECES.length ? '' : ' из ' + PIECES.length);
}
document.getElementById('pq').oninput = renderPieces;
(function(){ const c = document.getElementById('pincomplete'); if(c) c.onchange = renderPieces; })();

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
  if(!full || !full.graph) return { nodes: [], edges: [] };
  const byId = {}; (full.graph.nodes || []).forEach(n => byId[n.id] = n);
  const edges = (full.graph.edges || []).map(e => ({ from: flowNodeLabel(byId[e.from]), to: flowNodeLabel(byId[e.to]) }));
  return { nodes: full.graph.nodes || [], edges };
}
async function renderFlows(){
  const host = document.getElementById('flows');
  document.getElementById('fcnt').textContent = FLOWS.length;
  if(!FLOWS.length){ host.innerHTML = '<div class="empty">Сохранённых схем пока нет. Собери граф в Конструкторе и нажми «🗂 схемы».</div>'; return; }
  host.innerHTML = '';
  for(const f of FLOWS.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))){
    const { edges } = await loadFlowEdges(f);
    const box = document.createElement('div'); box.className = 'flow';
    box.innerHTML = '<h3>' + esc(f.name) + '</h3><div class="fmeta">' + f.nodes + ' узлов · ' + f.edges + ' связей</div>'
      + (edges.length ? edges.map(e => '<div class="edge">' + esc(e.from) + ' <span class="arr">→</span> ' + esc(e.to) + '</div>').join('')
                      : '<div class="muted" style="font-size:12px">связей нет</div>');
    host.appendChild(box);
    f._edges = edges;
  }
}
function flowsAsText(){
  const lines = ['# Схемы и связи (' + FLOWS.length + ')', ''];
  FLOWS.forEach(f => {
    lines.push('## ' + f.name + '  (' + f.nodes + ' узлов, ' + f.edges + ' связей)');
    (f._edges || []).forEach(e => lines.push('  ' + e.from + ' -> ' + e.to));
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
document.getElementById('fcopy').onclick = e => copy(flowsAsText(), e.target);
