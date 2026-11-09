import test from 'node:test';
import assert from 'node:assert/strict';
import HTMLCandidates from '../public/html-candidates.js';

test('HTML tag candidates are filtered by prefix and include Russian explanations', () => {
  const result = HTMLCandidates.tags({
    htmlTags: {
      div: '<div> — блочный контейнер.',
      dialog: '<dialog> — диалоговое окно.',
      button: '<button> — кнопка.',
      '!doctype': '<!doctype html> — объявление документа.',
    },
  }, 'di');
  assert.deepEqual(result.map(item => item.code), ['div', 'dialog']);
  assert.equal(result[0].expected, 'tag-name');
  assert.equal(result[0].note, 'блочный контейнер.');
});

test('HTML tag candidates are not shown without a prefix', () => {
  assert.deepEqual(HTMLCandidates.tags({ htmlTags: { div: 'контейнер' } }, ''), []);
});
