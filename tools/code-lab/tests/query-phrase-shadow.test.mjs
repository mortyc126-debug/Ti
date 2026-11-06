import assert from 'node:assert/strict';
import { createLegacyQueryPhraseShadow } from '../lib/query-phrase-shadow.mjs';

const pieces = {
  'css:padding': [{ id: 'padding-example', title: 'Внутренний отступ', lang: 'css' }],
  'css:margin': [{ id: 'margin-example', title: 'Внешний отступ', lang: 'css' }],
};
const usage = {
  terms: { css: { padding: {}, margin: {} } },
  piecesOf(section, key) { return (pieces[section + ':' + key] || []).map(x => x.id); },
  pieceInfo(id) { return Object.values(pieces).flat().find(x => x.id === id) || null; }
};
const index = createLegacyQueryPhraseShadow({
  queryPhrases: [
    { id: 'a', phrase: 'отступ внутри элемента', targetKey: 'padding', language: 'css', scope: 'box' },
    { id: 'b', phrase: 'отступ снаружи элемента', targetKey: 'margin', language: 'css', scope: 'box' },
    { id: 'c', phrase: 'отступ', targetKey: 'padding' },
    { id: 'd', phrase: 'отступ', targetKey: 'margin' }
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
assert.equal(ambiguous.ambiguous, 1);

assert.equal(index.search('   ').total, 0);
console.log('query-phrase-shadow: isolated index tests passed');
