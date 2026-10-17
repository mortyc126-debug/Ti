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
  const edges = (full.graph.edges || []).map(e => ({ from: flowNodeLabel(byId[e.from]), to: flowNodeLabel(byId[e.to]), kind: e.kind || 'data' }));
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
      + (edges.length ? edges.map(e => { const r = (window.relationById && window.relationById(e.kind)) || { label: '', color: '#888' }; return '<div class="edge">' + esc(e.from) + ' <span class="arr" style="color:' + r.color + '">—[' + esc(r.label) + ']→</span> ' + esc(e.to) + '</div>'; }).join('')
                      : '<div class="muted" style="font-size:12px">связей нет</div>');
    host.appendChild(box);
    f._edges = edges;
  }
}
function flowsAsText(){
  const lines = ['# Схемы и связи (' + FLOWS.length + ')', ''];
  FLOWS.forEach(f => {
    lines.push('## ' + f.name + '  (' + f.nodes + ' узлов, ' + f.edges + ' связей)');
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
document.getElementById('fcopy').onclick = e => copy(flowsAsText(), e.target);

// ── импорт связей/контрактов из текста ────────────────────────────────────────
const el2 = (tag, cls, html) => { const e = document.createElement(tag); if(cls) e.className = cls; if(html != null) e.innerHTML = html; return e; };
function split2(s, sep){ const i = s.indexOf(sep); return [s.slice(0, i), s.slice(i + sep.length)]; }
function resolveName(nm){ const q = String(nm || '').trim().toLowerCase(); return PIECES.find(t => (t.title || '').trim().toLowerCase() === q) || PIECES.find(t => t.id === String(nm || '').trim()) || null; }
function parseLinks(text){
  const edges = [], contracts = [], errors = []; let flowName = '';
  String(text).split('\n').forEach((raw, i) => {
    const line = raw.trim(); const ln = i + 1;
    if(!line) return;
    if(line.startsWith('#') || line.startsWith('//')){ const m = line.match(/схема[:\s]+(.+)/i); if(m) flowName = m[1].trim(); return; }
    let m;
    if((m = line.match(/^схема[:\s]+(.+)/i))){ flowName = m[1].trim(); return; }
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
        else if(/^\s*вход|input/.test(key)) fields.input = val;
        else if(/^\s*выход|output/.test(key)) fields.output = val;
      });
      contracts.push({ name: name.trim(), fields, ln }); return;
    }
    // стрелки = поток данных
    if((m = line.match(/^(.+?)\s*(?:->|→|=>)\s*(.+)$/))){ edges.push({ a: m[1].trim(), b: m[2].trim(), kind: 'data', ln }); return; }
    // любой вид связи по ключевому слову из словаря (window.relationKwIndex)
    const kws = (window.relationKwIndex || []).filter(x => !/^(->|→|=>)$/.test(x.k));
    let hit = null;
    for(const x of kws){
      const re = new RegExp('^(.+?)\\s+' + x.k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+(.+)$', 'i');
      const mm = line.match(re); if(mm){ hit = { a: mm[1].trim(), b: mm[2].trim().replace(/^(с|со|от|на|для|в|к|в\s)\s+/i, ''), r: x.r }; break; }
    }
    if(hit){ edges.push({ a: hit.a, b: hit.b, kind: hit.r.id, ln }); return; }
    errors.push('строка ' + ln + ': не понял — «' + line + '»');
  });
  return { edges, contracts, errors, flowName };
}
async function applyLinks(P){
  for(const c of P.contracts){
    const t = resolveName(c.name); if(!t) continue;
    const f = c.fields, body = { id: t.id };
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
  const used = new Map(), nodes = [], edges = []; let col = 0;
  const ensureNode = async t => {
    if(used.has(t.id)) return used.get(t.id);
    const full = await fetch('/api/template?id=' + encodeURIComponent(t.id)).then(r => r.json()).catch(() => null);
    const code = ((full && full.lines) || []).map(l => (l || []).map(k => k.v != null ? k.v : '').join('')).join('\n');
    const nid = Math.random().toString(36).slice(2, 8);
    nodes.push({ id: nid, blockId: 'raw', fields: { code }, title: t.title, desc: (full && full.desc) || '', src: { id: t.id, title: t.title, desc: (full && full.desc) || '', code }, x: 60 + (col % 4) * 240, y: 60 + Math.floor(col / 4) * 170 });
    col++; used.set(t.id, nid); return nid;
  };
  for(const e of P.edges){ const ta = resolveName(e.a), tb = resolveName(e.b); if(!ta || !tb) continue; const na = await ensureNode(ta), nb = await ensureNode(tb); const kind = e.kind || 'data'; if(!edges.some(x => x.from === na && x.to === nb && x.kind === kind)) edges.push({ from: na, to: nb, kind }); }
  let flowId = null;
  if(nodes.length){
    const name = P.flowName || ('Импорт связей ' + new Date().toLocaleDateString('ru'));
    const r = await fetch('/api/flows/save', { method:'POST', body: JSON.stringify({ name, graph: { nodes, edges } }) }).then(r => r.json()).catch(() => ({}));
    flowId = r.id;
  }
  return { contracts: P.contracts.length, edges: edges.length, nodes: nodes.length, flowId };
}
const LINKS_SAMPLE = [
  '# Связи пишутся: Кусок A <вид> Кусок B. Виды — в справочнике ниже.',
  '# Стрелка -> (или →) = передаёт данные. Контракт: Имя:: ключ=значение; ...',
  '',
  'схема: Среднее по списку',
  'Массив чисел -> Сумма (reduce)',
  'Сумма (reduce) -> Среднее',
  'Среднее зависит от Сумма (reduce)',
  'Валидатор проверяет Среднее',
  'Тест среднего тестирует Среднее',
  'Старое среднее заменяет Среднее',
  '',
  'Среднее:: нужно=сумма, количество; даёт=среднее; среда=браузер; проверка=сравни с ручным счётом'
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
    + '<p class="mh">Вставь правила — приложение разберёт связи и контракты кусков. Куски ищутся по названию. Связи соберутся в схему, контракты («нужно/даёт/среда/ошибка/проверка/вход/выход») запишутся на куски.</p>'
    + '<div class="fmt">A -> B&#10;A зависит от B · A оборачивает B · A конфликтует с B …&#10;Имя:: нужно=x,y; даёт=z; среда=браузер; ошибка=...; проверка=...&#10;схема: Название</div>'
    + '<details class="rr"><summary>виды связей, которые понимает парсер (' + (window.CODE_RELATIONS || []).length + ')</summary><div class="rr-box">' + relationsRef() + '</div></details>'
    + '<textarea id="lk-text" placeholder="вставь текст или нажми «пример»"></textarea>'
    + '<div class="mbtns"><button class="btn" id="lk-sample">пример</button><button class="btn ok" id="lk-parse">разобрать</button><button class="btn" id="lk-apply" style="display:none">применить</button><button class="btn" id="lk-close">закрыть</button></div>'
    + '<div class="lp-prev" id="lk-prev"></div>';
  bg.appendChild(box); document.body.appendChild(bg);
  const q = s => bg.querySelector(s);
  bg.onclick = e => { if(e.target === bg) bg.remove(); };
  q('#lk-close').onclick = () => bg.remove();
  q('#lk-sample').onclick = () => { q('#lk-text').value = LINKS_SAMPLE; };
  let parsed = null;
  q('#lk-parse').onclick = () => {
    parsed = parseLinks(q('#lk-text').value);
    const prev = q('#lk-prev'); prev.innerHTML = '';
    const line = (txt, cls) => { const d = el2('div', 'lp-row ' + (cls || '')); d.textContent = txt; return d; };
    prev.appendChild(el2('div', 'lp-sec', 'связи (' + parsed.edges.length + ')'));
    parsed.edges.forEach(e => { const a = resolveName(e.a), b = resolveName(e.b); const ok = a && b; const rel = (window.relationById && window.relationById(e.kind)) || { label: 'связь' }; prev.appendChild(line((ok ? '✓ ' : '✕ ') + e.a + '  —[' + rel.label + ']→  ' + e.b + (ok ? '' : '  (не найдено: ' + [!a ? e.a : '', !b ? e.b : ''].filter(Boolean).join(', ') + ')'), ok ? 'lp-ok' : 'lp-bad')); });
    prev.appendChild(el2('div', 'lp-sec', 'контракты (' + parsed.contracts.length + ')'));
    parsed.contracts.forEach(c => { const t = resolveName(c.name); prev.appendChild(line((t ? '✓ ' : '✕ ') + c.name + ': ' + Object.keys(c.fields).join(', ') + (t ? '' : '  (кусок не найден)'), t ? 'lp-ok' : 'lp-bad')); });
    if(parsed.errors.length){ prev.appendChild(el2('div', 'lp-sec', 'не разобрано')); parsed.errors.forEach(x => prev.appendChild(line(x, 'lp-bad'))); }
    q('#lk-apply').style.display = (parsed.edges.length || parsed.contracts.length) ? '' : 'none';
  };
  q('#lk-apply').onclick = async () => {
    if(!parsed) return;
    q('#lk-apply').textContent = 'применяю…'; q('#lk-apply').disabled = true;
    const r = await applyLinks(parsed);
    try { PIECES = await fetch('/api/list').then(x => x.json()); FLOWS = await fetch('/api/flows/list').then(x => x.json()); } catch(_){}
    renderPieces(); renderFlows();
    q('#lk-prev').innerHTML = '<div class="lp-row lp-ok">Готово: контрактов обновлено ' + r.contracts + ', связей ' + r.edges + (r.flowId ? ', схема сохранена' : '') + '.</div>';
    q('#lk-apply').style.display = 'none';
  };
}
document.getElementById('plinks').onclick = openLinksModal;
