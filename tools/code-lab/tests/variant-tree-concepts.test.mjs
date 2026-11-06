import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVariants } from '../lib/variant-tree.mjs';

const concepts = [{
  id: 'debounce',
  name: 'Отложенный вызов',
  definition: 'Откладывает действие до паузы во входящем потоке событий.',
  aliases: ['debounce', 'задержка частых вызовов'],
  forms: [
    { value: 'debounce(fn, delay)', language: 'js', kind: 'syntax', note: 'Обёртка для функции' },
    { value: 'setTimeout(callback, delay)', language: 'js', kind: 'alternative', note: 'Простой таймер' },
    { value: 'loop.call_later(delay, callback)', language: 'python', kind: 'syntax', note: 'Отложенный вызов в asyncio' }
  ],
  tags: ['таймеры', 'события'],
  examples: [{ pieceId: 'js-debounce', note: 'Полная реализация' }]
}];

const queryPhrases = [{
  id: 'q-debounce',
  phrase: 'не вызывать сразу после каждого события',
  targetConceptId: 'debounce',
  language: 'js',
  scope: 'события',
  origin: 'manual'
}];

const rows = [{ id: 'js-debounce', lang: 'js', title: 'Реализация отложенного вызова', code: 'function debounce() {}' }];
const dict = { langs: { js: {}, python: {} } };

function conceptGroup(result) {
  return result.roots.find(x => x.group && x.label === 'Мои конструкции');
}

test('находит пользовательскую конструкцию по её названию и варианту названия', () => {
  for (const q of ['отложенный', 'debounce']) {
    const group = conceptGroup(buildVariants({ q, lang: 'js', dict, rows, concepts, queryPhrases }));
    assert.ok(group, 'должна появиться отдельная группа пользовательских конструкций');
    assert.equal(group.children[0].label, 'Отложенный вызов');
    assert.match(group.children[0].note, /паузы/);
  }
});

test('показывает сохранённые варианты записи и примеры, не смешивая их с синонимами', () => {
  const group = conceptGroup(buildVariants({ q: 'debounce', lang: 'js', dict, rows, concepts, queryPhrases }));
  const item = group.children[0];
  assert.deepEqual(item.children.filter(x => !x.group).map(x => x.code), [
    'debounce(fn, delay)',
    'setTimeout(callback, delay)'
  ]);
  const examples = item.children.find(x => x.group && x.label === 'Примеры');
  assert.ok(examples);
  assert.equal(examples.children[0].piece, 'js-debounce');
});

test('учитывает язык формы и поисковую формулировку', () => {
  const js = conceptGroup(buildVariants({ q: 'не вызывать сразу после каждого события', lang: 'js', dict, rows, concepts, queryPhrases }));
  assert.ok(js);
  assert.ok(js.children[0].children.some(x => x.code === 'debounce(fn, delay)'));
  const py = conceptGroup(buildVariants({ q: 'debounce', lang: 'python', dict, rows, concepts, queryPhrases }));
  assert.ok(py);
  assert.deepEqual(py.children[0].children.filter(x => !x.group).map(x => x.code), [
    'loop.call_later(delay, callback)'
  ]);
});

test('не показывает пользовательские конструкции по нерелевантному запросу', () => {
  const result = buildVariants({ q: 'таблица', lang: 'js', dict, rows, concepts, queryPhrases });
  assert.equal(conceptGroup(result), undefined);
});
