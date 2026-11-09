import test from 'node:test';
import assert from 'node:assert/strict';
import CSSCandidates from '../public/css-candidates.js';

const dictionary = {
  cssProps: {
    display: 'display — тип раскладки: block, flex, grid.',
    'align-items': 'align-items — выравнивание элементов по поперечной оси.',
    'justify-content': 'justify-content — распределение элементов по главной оси.',
    color: 'color — цвет текста.',
  },
};

test('CSS property candidates are filtered by the typed prefix and explained in Russian', () => {
  const result = CSSCandidates.properties(dictionary, 'ali');
  assert.equal(result.length, 1);
  assert.equal(result[0].code, 'align-items');
  assert.equal(result[0].note, 'выравнивание элементов по поперечной оси.');
  assert.equal(result[0].expected, 'property-name');
  assert.deepEqual(result[0].contexts, ['css-property']);
});

test('CSS property candidates do not return the whole dictionary for an empty prefix', () => {
  assert.deepEqual(CSSCandidates.properties(dictionary, ''), []);
});

test('CSS property candidates preserve stable dictionary order for common prefixes', () => {
  const result = CSSCandidates.properties(dictionary, 'j');
  assert.deepEqual(result.map(item => item.code), ['justify-content']);
});
