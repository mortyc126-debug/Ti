const $ = id => document.getElementById(id);
let data = { schemaVersion: 2, concepts: [], relations: [], queryPhrases: [] };
let relationTypes = {}, pieces = [], selectedId = '', examples = [], relations = [];
const now = () => new Date().toISOString();
const norm = value => String(value || '').trim().toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ');
async function api(url, options) {
  const response = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {}));
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = (body.errors || []).map(x => x.path + ': ' + x.message).join('\n');
    throw new Error([body.error || ('HTTP ' + response.status), details].filter(Boolean).join('\n'));
  }
  return body;
}
function message(value, error) {
  $('concept-status').textContent = value || '';
  $('concept-status').classList.toggle('error', !!error);
}
function node(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}
function lines(value) { return value.split(/\r?\n/).map(x => x.trim()).filter(Boolean); }
function formsFromText(value) {
  return lines(value).map(line => {
    const p = line.split('|').map(x => x.trim());
    if (p.length === 1) return { value: p[0], language: '', kind: 'text', note: '' };
    return { language: p[0] || '', kind: p[1] || 'syntax', value: p[2] || '', note: p.slice(3).join(' | ') };
  }).filter(x => x.value);
}
function formsToText(items) {
  return (items || []).map(x => [x.language || '', x.kind || 'syntax', x.value || '', x.note || ''].join(' | ')).join('\n');
}
function queryPhrasesToText(items) {
  return (items || []).map(x => [x.language || '', x.scope || '', x.phrase || '', x.note || ''].join(' | ')).join('\n');
}
function queryPhrasesFromText(value, conceptId) {
  const previous = data.queryPhrases.filter(x => x.targetConceptId === conceptId);
  const used = new Set();
  return lines(value).map(line => {
    const p = line.split('|').map(x => x.trim());
    const [language = '', scope = '', phrase = '', note = ''] = p.length === 1 ? ['', '', p[0], ''] : p;
    if (!phrase) return null;
    const key = [norm(language), norm(scope), norm(phrase)].join('|');
    const old = previous.find(x => !used.has(x.id) && [norm(x.language), norm(x.scope), norm(x.phrase)].join('|') === key);
    if (old) used.add(old.id);
    return Object.assign({}, old || {}, {
      id: old ? old.id : 'query-' + crypto.randomUUID().slice(0, 12),
      phrase, targetConceptId: conceptId, language, scope, note,
      origin: old && old.origin ? old.origin : 'manual'
    });
  }).filter(Boolean);
}
function fillPieces() {
  const select = $('example-piece');
  select.replaceChildren(new Option('Выбери фрагмент', ''));
  pieces.forEach(x => select.add(new Option((x.title || x.id) + ' · ' + (x.lang || ''), x.id)));
}
function fillRelationTypes() {
  const select = $('relation-type');
  select.replaceChildren();
  Object.entries(relationTypes).forEach(([id, value]) => select.add(new Option(value.label || id, id)));
  fillTargets();
}
function fillTargets() {
  const select = $('relation-target');
  select.replaceChildren(new Option('Выбери понятие', ''));
  data.concepts.filter(x => x.id !== selectedId).forEach(x => select.add(new Option(x.name, x.id)));
}
function renderExamples() {
  const root = $('concept-examples'); root.replaceChildren();
  if (!examples.length) { root.append(node('div', 'concept-empty', 'Пока нет примеров')); return; }
  examples.forEach((item, index) => {
    const piece = pieces.find(x => x.id === item.pieceId);
    const row = node('div', 'concept-chip');
    row.append(node('div', 'concept-chip-text', (piece ? piece.title : item.pieceId) + (item.note ? ' — ' + item.note : '')));
    const remove = node('button', 'concept-chip-remove', '×'); remove.type = 'button'; remove.title = 'Убрать пример';
    remove.addEventListener('click', () => { examples.splice(index, 1); renderExamples(); });
    row.append(remove); root.append(row);
  });
}
function renderRelations() {
  const root = $('concept-relations'); root.replaceChildren();
  const list = relations.map((item, index) => ({ item, index })).filter(x => x.item.from === selectedId || x.item.to === selectedId);
  if (!list.length) { root.append(node('div', 'concept-empty', 'Пока нет связей')); return; }
  list.forEach(({ item, index }) => {
    const outgoing = item.from === selectedId;
    const otherId = outgoing ? item.to : item.from;
    const other = data.concepts.find(x => x.id === otherId);
    const label = (relationTypes[item.type] || {}).label || item.type;
    const row = node('div', 'concept-relation');
    row.append(node('div', 'concept-relation-text', outgoing ? label + ' → ' + (other ? other.name : otherId) : (other ? other.name : otherId) + ' → ' + label));
    const remove = node('button', 'concept-chip-remove', '×'); remove.type = 'button'; remove.title = 'Убрать связь';
    remove.addEventListener('click', () => { relations.splice(index, 1); renderRelations(); });
    row.append(remove); root.append(row);
  });
}
function renderList(hits) {
  const root = $('concept-list'); root.replaceChildren();
  if (!hits.length) { root.append(node('div', 'concept-empty', 'Ничего не найдено')); return; }
  hits.forEach(hit => {
    const button = node('button', 'concept-list-item' + (hit.id === selectedId ? ' active' : ''));
    button.type = 'button';
    button.append(node('strong', '', hit.name));
    if (hit.definition) button.append(node('span', '', hit.definition));
    if (hit.match && hit.match.label) button.append(node('small', '', hit.match.label));
    button.addEventListener('click', () => selectConcept(hit.id));
    root.append(button);
  });
}
async function searchList() {
  try {
    const result = await api('/api/concepts/search?q=' + encodeURIComponent($('concept-search').value.trim()));
    renderList(result.hits || []);
  } catch (error) { message(error.message, true); }
}
function selectConcept(id) {
  const concept = data.concepts.find(x => x.id === id);
  if (!concept) return;
  selectedId = id; examples = (concept.examples || []).map(x => Object.assign({}, x));
  relations = data.relations.map(x => Object.assign({}, x));
  $('concept-id').value = id;
  $('concept-mode').textContent = 'СОХРАНЁННАЯ КОНСТРУКЦИЯ';
  $('concept-heading').textContent = concept.name;
  $('concept-name').value = concept.name || '';
  $('concept-definition').value = concept.definition || '';
  $('concept-aliases').value = (concept.aliases || []).map(x => typeof x === 'string' ? x : x.value).join('\n');
  $('concept-forms').value = formsToText(concept.forms);
  $('concept-query-phrases').value = queryPhrasesToText(data.queryPhrases.filter(x => x.targetConceptId === id));
  $('concept-tags').value = (concept.tags || []).join(', ');
  $('delete-concept').disabled = false;
  fillTargets(); renderExamples(); renderRelations(); searchList(); message('');
}
function newConcept() {
  selectedId = 'concept-' + crypto.randomUUID().slice(0, 12);
  examples = []; relations = data.relations.map(x => Object.assign({}, x));
  $('concept-id').value = selectedId;
  $('concept-mode').textContent = 'НОВАЯ КОНСТРУКЦИЯ';
  $('concept-heading').textContent = 'Новая конструкция';
  $('concept-name').value = ''; $('concept-definition').value = '';
  $('concept-aliases').value = ''; $('concept-forms').value = ''; $('concept-query-phrases').value = ''; $('concept-tags').value = '';
  $('delete-concept').disabled = true;
  fillTargets(); renderExamples(); renderRelations(); message('');
  $('concept-name').focus();
}
async function saveConcept(event) {
  event.preventDefault();
  const name = $('concept-name').value.trim();
  if (!name) return message('Укажи название конструкции.', true);
  const previous = data.concepts.find(x => x.id === selectedId);
  const stamp = now();
  const concept = Object.assign({}, previous || {}, {
    id: selectedId, name, definition: $('concept-definition').value.trim(),
    aliases: lines($('concept-aliases').value), forms: formsFromText($('concept-forms').value),
    tags: $('concept-tags').value.split(',').map(x => x.trim()).filter(Boolean),
    examples: examples.map(x => Object.assign({}, x)), origin: 'manual',
    createdAt: previous && previous.createdAt ? previous.createdAt : stamp, updatedAt: stamp
  });
  const next = {
    ...data,
    schemaVersion: 2,
    concepts: data.concepts.filter(x => x.id !== selectedId).concat([concept]),
    relations,
    queryPhrases: data.queryPhrases.filter(x => x.targetConceptId !== selectedId).concat(queryPhrasesFromText($('concept-query-phrases').value, selectedId))
  };
  try {
    const result = await api('/api/concepts/save', { method: 'POST', body: JSON.stringify(next) });
    data = next; $('concept-mode').textContent = 'СОХРАНЁННАЯ КОНСТРУКЦИЯ';
    $('concept-heading').textContent = name; $('delete-concept').disabled = false;
    fillTargets(); await searchList();
    message('Сохранено. Понятий: ' + result.count + '; связей: ' + result.relationCount + '.');
  } catch (error) { message(error.message, true); }
}
async function deleteConcept() {
  if (!selectedId || !data.concepts.some(x => x.id === selectedId)) return;
  if (!confirm('Удалить это понятие? Его связи будут удалены, остальные понятия и фрагменты останутся.')) return;
  try {
    await api('/api/concepts/delete', { method: 'POST', body: JSON.stringify({ id: selectedId }) });
    data.concepts = data.concepts.filter(x => x.id !== selectedId);
    data.relations = data.relations.filter(x => x.from !== selectedId && x.to !== selectedId);\n    data.queryPhrases = data.queryPhrases.filter(x => x.targetConceptId !== selectedId);
    newConcept(); await searchList(); message('Понятие удалено.');
  } catch (error) { message(error.message, true); }
}
function addExample() {
  const pieceId = $('example-piece').value;
  if (!pieceId) return message('Сначала выбери фрагмент.', true);
  if (examples.some(x => x.pieceId === pieceId)) return message('Этот пример уже добавлен.', true);
  examples.push({ pieceId, note: $('example-note').value.trim() });
  $('example-piece').value = ''; $('example-note').value = '';
  renderExamples(); message('Пример добавлен в черновик. Не забудь сохранить конструкцию.');
}
function addRelation() {
  const to = $('relation-target').value, type = $('relation-type').value;
  if (!to || !type) return message('Выбери тип связи и другое понятие.', true);
  if (relations.some(x => x.from === selectedId && x.to === to && x.type === type)) return message('Такая связь уже есть.', true);
  relations.push({ id: 'relation-' + crypto.randomUUID().slice(0, 12), from: selectedId, to, type, note: $('relation-note').value.trim(), origin: 'manual', createdAt: now() });
  $('relation-target').value = ''; $('relation-note').value = '';
  renderRelations(); message('Связь добавлена в черновик. Не забудь сохранить конструкцию.');
}
async function init() {
  try {
    const results = await Promise.all([api('/api/concepts'), api('/api/list')]);
    data = { ...results[0], schemaVersion: results[0].schemaVersion || 2, concepts: results[0].concepts || [], relations: results[0].relations || [], queryPhrases: results[0].queryPhrases || [] };
    relationTypes = results[0].relationTypes || {};
    pieces = Array.isArray(results[1]) ? results[1] : [];
    fillPieces(); fillRelationTypes();
    $('concept-search').addEventListener('input', searchList);
    $('new-concept').addEventListener('click', newConcept);
    $('concept-form').addEventListener('submit', saveConcept);
    $('delete-concept').addEventListener('click', deleteConcept);
    $('add-example').addEventListener('click', addExample);
    $('add-relation').addEventListener('click', addRelation);
    await searchList();
    if (data.concepts.length) selectConcept(data.concepts[0].id); else newConcept();
  } catch (error) { message(error.message, true); }
}
document.addEventListener('DOMContentLoaded', init);
