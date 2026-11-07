import assert from 'node:assert/strict';
import { createLegacyQueryPhraseShadow } from '../lib/query-phrase-shadow.mjs';

const pieces = {
  'css:padding': [{ id: 'padding-example', title: 'Внутренний отступ', lang: 'css', code: '.box { padding: 12px; }' }],
  'css:margin': [{ id: 'margin-example', title: 'Внешний отступ', lang: 'css', code: '.box { margin: 12px; }' }],
};
const usage = {
  terms: { css: { padding: {}, margin: {} } },
  piecesOf(section, key) { return (pieces[section + ':' + key] || []).map(x => x.id); },
  pieceInfo(id) { return Object.values(pieces).flat().find(x => x.id === id) || null; },
  pieceText(id) { return Object.values(pieces).flat().find(x => x.id === id)?.code || ''; }
};
const index = createLegacyQueryPhraseShadow({
  queryPhrases: [
    { id: 'a', phrase: 'отступ внутри элемента', targetKey: 'padding', language: 'css', scope: 'box' },
    { id: 'b', phrase: 'отступ снаружи элемента', targetKey: 'margin', language: 'css', scope: 'box' },
    { id: 'c', phrase: 'отступ', targetKey: 'padding' },
    { id: 'd', phrase: 'отступ', targetKey: 'margin' },
    { id: 'e', phrase: 'disjoint', targetKey: 'set.isdisjoint(o)' }
  ],
  usage
});

const inside = index.search('отступ внутри элемента', { language: 'css', scope: 'box' });
assert.equal(inside.hits[0].targetKey, 'padding');
assert.deepEqual(inside.hits[0].pieces.map(x => x.id), ['padding-example']);
assert.equal(inside.hits.some(x => x.targetKey === 'margin'), false);

const outside = index.search('отступ снаружи элемента', { language: 'css', scope: 'box' });
assert.equal(outside.hits[0].targetKey, 'margin');
assert.equal(outside.hits.some(x => x.targetKey === 'padding'), false);

const ambiguous = index.search('отступ');
assert.deepEqual(new Set(ambiguous.hits.map(x => x.targetKey)), new Set(['padding', 'margin']));
assert.equal(ambiguous.ambiguous, true);

// Подстрока внутри другого слова не считается совпадением: join не должен находить disjoint.
assert.equal(index.search('join').total, 0);
assert.equal(index.search('ступ').total, 0);
assert.equal(index.search('   ').total, 0);

// Проверка содержимого: display:grid не является способом скрыть элемент.
const displayPieces = [
  { id: 'grid', title: 'Сетка', lang: 'css', code: '.grid { display: grid; }' },
  { id: 'hidden', title: 'Скрыть элемент', lang: 'css', code: '.gone { display: none; }' }
];
const displayUsage = {
  terms: { css: { display: {} } },
  piecesOf() { return displayPieces.map(piece => piece.id); },
  pieceInfo(id) { return displayPieces.find(piece => piece.id === id) || null; },
  pieceText(id) { return displayPieces.find(piece => piece.id === id)?.code || ''; }
};
const displayIndex = createLegacyQueryPhraseShadow({
  queryPhrases: [{ id: 'hide', phrase: 'скрыть элемент', targetKey: 'display' }],
  usage: displayUsage
});
const hidden = displayIndex.search('скрыть элемент');
assert.deepEqual(hidden.hits[0].pieces.map(piece => piece.id), ['hidden']);

// Известные ложные семантические пары исключены, даже если в библиотеке есть код.
const pythonUsage = {
  terms: { python: { lambda: {}, id: {} } },
  piecesOf(section, key) { return key === 'lambda' ? ['lambda-code'] : ['id-code']; },
  pieceInfo(id) { return id === 'lambda-code'
    ? { id, title: 'Python lambda', lang: 'python' }
    : { id, title: 'HTML id', lang: 'html' }; },
  pieceText(id) { return id === 'lambda-code' ? 'lambda x: x + 1' : '<input id="name">'; }
};
const excludedIndex = createLegacyQueryPhraseShadow({
  queryPhrases: [
    { id: 'arrow', phrase: 'стрелочная функция', targetKey: 'lambda' },
    { id: 'find-id', phrase: 'найти элемент по id', targetKey: 'id' }
  ],
  usage: pythonUsage
});
assert.equal(excludedIndex.search('стрелочная функция').total, 0);
assert.equal(excludedIndex.search('найти элемент по id').total, 0);

// CSS float не является числом с плавающей точкой.
const floatPieces = [
  { id: 'css-float', title: 'Обтекание', lang: 'css' },
  { id: 'py-float', title: 'Число float', lang: 'python' }
];
const floatUsage = {
  terms: { css: { float: {} }, python: { float: {} } },
  piecesOf(section) { return section === 'css' ? ['css-float'] : ['py-float']; },
  pieceInfo(id) { return floatPieces.find(piece => piece.id === id) || null; },
  pieceText(id) { return id === 'css-float' ? 'img { float: left; }' : 'value = float(text)'; }
};
const floatIndex = createLegacyQueryPhraseShadow({
  queryPhrases: [{ id: 'float-type', phrase: 'число с плавающей точкой', targetKey: 'float' }],
  usage: floatUsage
});
assert.deepEqual(floatIndex.search('число с плавающей точкой').rankedPieces.map(piece => piece.id), ['py-float']);

// pandas.DataFrame.copy() не является copy.copy() и не должно попадать в поверхностную копию Python-объекта.
const copyPieces = [
  { id: 'real-copy', title: 'Поверхностная копия', lang: 'python' },
  { id: 'pandas-copy', title: 'Очистка данных pandas', lang: 'python' }
];
const copyUsage = {
  terms: { python: { 'copy.copy(obj)': {} } },
  piecesOf() { return ['real-copy', 'pandas-copy']; },
  pieceInfo(id) { return copyPieces.find(piece => piece.id === id) || null; },
  pieceText(id) { return id === 'real-copy'
    ? 'import copy\nresult = copy.copy(source)'
    : 'import pandas as pd\nclean = raw.copy()'; }
};
const copyIndex = createLegacyQueryPhraseShadow({
  queryPhrases: [{ id: 'shallow-copy', phrase: 'поверхностная копия', targetKey: 'copy.copy(obj)' }],
  usage: copyUsage
});
assert.deepEqual(copyIndex.search('поверхностная копия').rankedPieces.map(piece => piece.id), ['real-copy']);

// Два targetKey с разными именами аргумента одной функции не создают ложную неоднозначность.
const deepCopyUsage = {
  terms: { python: { 'copy.deepcopy(obj)': {}, 'copy.deepcopy(x)': {} } },
  piecesOf() { return ['deep-copy']; },
  pieceInfo() { return { id: 'deep-copy', title: 'Глубокая копия', lang: 'python' }; },
  pieceText() { return 'copy.deepcopy(source)'; }
};
const deepCopyIndex = createLegacyQueryPhraseShadow({
  queryPhrases: [
    { id: 'deep-a', phrase: 'глубокая копия', targetKey: 'copy.deepcopy(obj)' },
    { id: 'deep-b', phrase: 'глубокая копия', targetKey: 'copy.deepcopy(x)' }
  ],
  usage: deepCopyUsage
});
assert.equal(deepCopyIndex.search('глубокая копия').total, 2);
assert.equal(deepCopyIndex.search('глубокая копия').ambiguous, false);

const taskPieces = {
  html: [{ id: 'button-piece', title: 'Кнопка страницы', lang: 'html', code: '<button type="button">Показать</button>' }],
  js: [
    { id: 'message-piece', title: 'Показать сообщение', lang: 'js', code: "alert('Готово')" },
    { id: 'click-piece', title: 'Обработчик нажатия', lang: 'js', code: "button.addEventListener('click', showMessage)" }
  ]
};
const taskUsage = {
  terms: { html: { button: {} }, js: { alert: {}, addeventlistener: {} } },
  piecesOf(section, key) { return (taskPieces[section] || []).filter(piece =>
    section === 'html' ? key === 'button' : key === 'alert' ? piece.id === 'message-piece' : piece.id === 'click-piece'
  ).map(piece => piece.id); },
  pieceInfo(id) { return Object.values(taskPieces).flat().find(piece => piece.id === id) || null; },
  pieceText(id) { return this.pieceInfo(id)?.code || ''; }
};
const taskIndex = createLegacyQueryPhraseShadow({
  queryPhrases: [
    { id: 'button', phrase: 'кнопка', targetKey: 'button' },
    { id: 'message', phrase: 'сообщение', targetKey: 'alert' },
    { id: 'click', phrase: 'нажатие', targetKey: 'addeventlistener' }
  ],
  usage: taskUsage
});
const task = taskIndex.search('Добавить кнопку, которая показывает сообщение при нажатии');
assert.deepEqual(new Set(task.hits.map(hit => hit.targetKey)), new Set(['button', 'alert', 'addeventlistener']));
assert.ok(task.hits.every(hit => hit.phrases[0].match.kind === 'partial'));

const reduceUsage = {
  terms: { js: { '.reduce': {} } },
  piecesOf() { return ['reduce-code']; },
  pieceInfo() { return { id: 'reduce-code', title: 'Свёртка массива', lang: 'js' }; },
  pieceText() { return 'const total = items.reduce((sum, item) => sum + item, 0)'; }
};
const reduceIndex = createLegacyQueryPhraseShadow({
  queryPhrases: [{ id: 'reduce', phrase: 'свернуть массив', targetKey: '.reduce' }],
  usage: reduceUsage
});
assert.equal(reduceIndex.search('свернуть боковую панель').total, 0);
assert.equal(reduceIndex.search('свернуть массив').hits[0].targetKey, '.reduce');

console.log('query-phrase-shadow: isolated index and content-filter tests passed');
