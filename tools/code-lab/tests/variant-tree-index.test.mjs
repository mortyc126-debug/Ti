import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVariants } from '../lib/variant-tree.mjs';

test('индекс сохраняет вложенность CSS-свойств по дефисам', () => {
  const dict = { langs: { css: {
    margin: '0: внешний отступ',
    'margin-inline': '0: внешний отступ по горизонтали',
    'margin-inline-start': '0: внешний отступ в начале строки',
    'margin-top': '0: внешний отступ сверху'
  } } };
  const result = buildVariants({ q: 'mar', lang: 'css', dict, rows: [], synonyms: {} });
  const root = result.roots.find(x => x.term === 'margin');
  assert.ok(root);
  const inline = root.children.find(x => x.term === 'margin-inline');
  assert.ok(inline);
  assert.ok(inline.children.some(x => x.term === 'margin-inline-start'));
  assert.ok(root.children.some(x => x.term === 'margin-top'));
});

test('индекс находит составные конструкции по отдельному слову', () => {
  const dict = { langs: { js: {
    queryselector: 'найти первый элемент по CSS-селектору',
    'document.queryselector(selector)': 'найти первый подходящий элемент документа'
  } } };
  const result = buildVariants({ q: 'query', lang: 'js', dict, rows: [], synonyms: {} });
  const root = result.roots.find(x => x.term === 'queryselector');
  assert.ok(root);
  assert.ok(root.children.some(x => x.term === 'document.queryselector(selector)'));
});

test('составные имена с точкой сохраняют готовый вызов', () => {
  const dict = { langs: { js: {
    'object.keys(obj)': 'получить список ключей объекта'
  } } };
  const synonyms = { 'object.keys': ['получить ключи объекта'] };
  const result = buildVariants({ q: 'получить ключи объекта', lang: 'js', dict, rows: [], synonyms });
  const root = result.roots.find(x => x.term === 'object.keys');
  assert.ok(root);
  assert.equal(root.code, 'object.keys(obj)');
});
