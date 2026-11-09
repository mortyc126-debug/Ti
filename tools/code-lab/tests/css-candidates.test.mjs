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

test('CSS custom property scan does not treat comment markers inside strings as comments', () => {
  const code = ':root { content: "/* --fake: red"; --real: 1rem; }';
  assert.deepEqual(CSSCandidates.variables(code, '--').map(item => item.code), ['--real']);
});

test('CSS selector candidates include shared dictionary pseudo-classes', () => {
  const result = CSSCandidates.selectors({
    words: { ':hover': ':hover — когда на элемент навели мышь' },
    langs: { css: { display: 'display — тип раскладки' } },
  }, ':ho');
  assert.deepEqual(result.map(item => item.code), [':hover']);
});


test('CSS selector candidates include HTML tag names inside selector-list functions', () => {
  const result = CSSCandidates.selectors({
    htmlTags: { div: 'div — блочный элемент.', button: 'button — кнопка.' },
    langs: { css: { display: 'display — тип раскладки.' } },
  }, 'di');
  assert.deepEqual(result.map(item => item.code), ['div']);
  assert.ok(result[0].contexts.includes('css-selector-argument'));
});

test('CSS pseudo-function candidates come from matching dictionary examples', () => {
  const dictionary = {
    langs: { css: {
      ':nth-child(odd)': 'выбрать нечётные дочерние элементы',
      ':nth-child(even)': 'выбрать чётные дочерние элементы',
      ':nth-child(2n + 1)': 'выбрать элементы по формуле',
      ':dir(rtl)': 'выбрать элементы с письмом справа налево',
      ':lang(ru)': 'выбрать элементы по языку содержимого',
    } },
  };
  assert.deepEqual(
    CSSCandidates.functionArguments(dictionary, 'nth-child', 'od').map(item => item.code),
    ['odd']
  );
  assert.deepEqual(
    CSSCandidates.functionArguments(dictionary, 'nth-child', '2n').map(item => item.code),
    ['2n + 1']
  );
  assert.deepEqual(
    CSSCandidates.functionArguments(dictionary, 'dir', 'rt').map(item => item.code),
    ['rtl']
  );
  assert.equal(CSSCandidates.functionArguments(dictionary, 'calc', '1').length, 0);
});
