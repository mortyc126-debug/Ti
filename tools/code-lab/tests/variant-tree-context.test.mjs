import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVariants } from '../lib/variant-tree.mjs';

const dict = {
  langs: {
    js: {
      if: 'условное выполнение блока',
      else: 'ветка иначе, если условие не выполнилось',
      'else if': 'дополнительная проверка условия',
      try: 'начинает блок обработки исключений',
      catch: 'перехватывает исключение',
      finally: 'выполняется всегда после try',
      await: 'ожидает завершения асинхронной операции'
    },
    python: {
      if: 'условное выполнение блока',
      elif: 'дополнительное условие после if',
      else: 'ветка иначе',
      await: 'ожидает завершения awaitable'
    }
  },
  structure: {
    js: [
      'if: пишется if (…) {\\n  …\\n}',
      'if: можно содержать else, else if',
      'else if: после if, else if',
      'else: после if, else if',
      'try: можно содержать catch, finally',
      'catch: после try',
      'finally: после try, catch',
      'await: внутри async — работает только внутри async-функции'
    ],
    python: [
      'if: пишется if …:\\n    …',
      'elif: после if, elif',
      'else: после if, elif, for, while, try, except',
      'await: внутри async — только внутри async def'
    ]
  }
};

test('показывает продолжения конструкции из обратных связей «после»', () => {
  const result = buildVariants({ q: 'if', lang: 'js', dict, rows: [], synonyms: {} });
  const root = result.roots.find(x => x.term === 'if');
  assert.ok(root, 'корень if должен находиться');
  const group = root.children.find(x => x.group && x.label === 'Варианты продолжения');
  assert.ok(group, 'у if должна быть группа продолжений');
  const terms = group.children.map(x => x.term);
  assert.ok(terms.includes('else'), 'else доступен после if');
  assert.ok(terms.includes('else if'), 'else if доступен после if');
  assert.match(group.children.find(x => x.term === 'else').note, /ветка иначе/);
  assert.ok(group.children.find(x => x.term === 'else if').code.includes('else if'), 'дочерняя конструкция должна вставляться кодом');
});

test('показывает допустимые части конструкции отдельно от синонимов', () => {
  const result = buildVariants({ q: 'try', lang: 'js', dict, rows: [], synonyms: {} });
  const root = result.roots.find(x => x.term === 'try');
  const group = root.children.find(x => x.group && x.label === 'Варианты продолжения');
  assert.ok(group);
  assert.deepEqual(group.children.map(x => x.term).sort(), ['catch', 'finally']);
});

test('показывает условия применения конструкции', () => {
  const result = buildVariants({ q: 'await', lang: 'js', dict, rows: [], synonyms: {} });
  const root = result.roots.find(x => x.term === 'await');
  const group = root.children.find(x => x.group && x.label === 'Условия применения');
  assert.ok(group);
  assert.match(group.children[0].show, /внутри: async/);
  assert.match(group.children[0].note, /только внутри async-функции/);
});

test('не смешивает правила продолжения разных языков', () => {
  const result = buildVariants({ q: 'if', lang: 'python', dict, rows: [], synonyms: {} });
  const root = result.roots.find(x => x.term === 'if');
  const group = root.children.find(x => x.group && x.label === 'Варианты продолжения');
  assert.deepEqual(group.children.map(x => x.term).sort(), ['elif', 'else']);
});
