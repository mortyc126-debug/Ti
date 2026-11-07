import test from 'node:test';
import assert from 'node:assert/strict';
import { combineTaskSearch } from '../lib/search-core.mjs';

test('объединяет направленные фразы и полнотекстовые фрагменты без потери источников', () => {
  const result = combineTaskSearch({
    query: 'добавить кнопку и обработчик нажатия',
    language: 'html',
    limit: 10,
    directed: {
      ambiguous: false,
      hits: [{ targetKey: 'button', score: 80, phrases: [{ phrase: 'кнопка', match: { matchedTokens: ['кнопк'] } }], sections: ['html'], pieces: [{ id: 'both' }] }],
      rankedPieces: [
        { id: 'both', title: 'Кнопка с действием', lang: 'html', targetKey: 'button', targetScore: 80, matchedTargets: ['button'] },
        { id: 'phrase-only', title: 'Нажатие кнопки', lang: 'js', targetKey: 'addEventListener', targetScore: 70 }
      ]
    },
    library: {
      hits: [
        { id: 'both', title: 'Кнопка с действием', lang: 'html', group: 'HTML: формы', why: [{ q: 'кнопка', kind: 'exact' }] },
        { id: 'text-only', title: 'Обработчик события', lang: 'js', group: 'JavaScript: события', why: [{ q: 'обработчик', kind: 'syn' }] }
      ]
    },
    variants: { roots: [{ term: 'button', lang: 'html', children: [] }] }
  });

  assert.equal(result.mode, 'task');
  assert.equal(result.targets[0].root.term, 'button');
  assert.deepEqual(result.pieces.map(piece => piece.id), ['both', 'phrase-only', 'text-only']);
  assert.deepEqual(result.pieces[0].sources, ['направленные фразы', 'полнотекстовый поиск']);
  assert.equal(result.pieces[0].matchedTargets[0], 'button');
  assert.equal(result.counts.pieces, 3);
});

test('объясняет результаты, найденные только одним источником', () => {
  const result = combineTaskSearch({
    query: 'отступ',
    directed: { hits: [], rankedPieces: [] },
    library: { hits: [{ id: 'margin', title: 'Внешний отступ', why: [{ q: 'отступ', kind: 'syn' }] }] },
    variants: { roots: [] }
  });
  assert.deepEqual(result.pieces[0].sources, ['полнотекстовый поиск']);
  assert.equal(result.pieces[0].why[0].source, 'полнотекстовый поиск');
});

console.log('search-core: source fusion tests passed');
