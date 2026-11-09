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

test('CSS selector candidates include pseudo-classes with their punctuation', () => {
  const result = CSSCandidates.selectors({
    langs: { css: {
      ':hover': ':hover — элемент при наведении указателя.',
      '::before': '::before — псевдоэлемент перед содержимым.',
      'display': 'display — тип раскладки.',
      ':focus-visible': ':focus-visible — видимый клавиатурный фокус.',
    } },
  }, ':ho');
  assert.deepEqual(result.map(item => item.code), [':hover']);
  assert.match(result[0].note, /наведении/);
});

test('CSS var() candidates come from declarations and ignore comments and strings', () => {
  const code = `:root {
    --gap: 1rem;
    --color-main: #123;
    /* --ghost: red; */
    content: "--fake: value";
  }
  .card { gap: var(--ga); }`;
  const result = CSSCandidates.variables(code, '--ga');
  assert.deepEqual(result.map(item => item.code), ['--gap']);
  assert.equal(result[0].expected, 'function-argument');
});

test('CSS custom property matching preserves case sensitivity', () => {
  const code = ':root { --Theme: dark; --theme: light; }';
  assert.deepEqual(CSSCandidates.variables(code, '--Th').map(item => item.code), ['--Theme']);
});
