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

console.log('query-phrase-shadow: isolated index and content-filter tests passed');
