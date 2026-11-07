import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildVariants } from '../lib/variant-tree.mjs';

const require = createRequire(import.meta.url);
const StructureRules = require('../public/structure-rules.js');

const rules = [
  'li: внутри ul, ol',
  'p: не содержит div, ul',
  'summary: первым в details',
  'elif: после if, elif',
  'try: содержит catch, finally',
  'await: внутри async — работает только внутри async-функции',
  'unsafe: не внутри script',
  'gap: требует display: flex | grid',
  'img: обязательно src',
  'img: можно alt, width',
  'button[type]: значения button, submit, reset',
  "id: связывает css #*, js getElementById('*')",
  'reader: читает js fetch',
  'header: заметка семантическая шапка страницы',
  'if: пишется if (…) {\\n  …\\n}'
];

const dict = {
  langs: {
    html: {
      li: 'элемент списка', ul: 'маркированный список', ol: 'нумерованный список',
      p: 'абзац', div: 'контейнер', summary: 'заголовок раскрывающегося блока',
      details: 'раскрывающийся блок', img: 'изображение', 'button[type]': 'тип кнопки',
      id: 'идентификатор', header: 'шапка страницы', script: 'скрипт', button: 'кнопка'
    },
    css: { gap: 'расстояние между элементами', '#*': 'селектор по id' },
    js: {
      if: 'условная конструкция', elif: 'дополнительное условие',
      try: 'обработка ошибок', catch: 'перехват ошибки', finally: 'завершение',
      await: 'ожидание операции', unsafe: 'условная конструкция',
      reader: 'чтение данных', fetch: 'сетевой запрос', getelementbyid: 'поиск элемента', alert: 'показать сообщение', addeventlistener: 'подписка на событие'
    }
  },
  structure: { html: rules.slice(0, 3).concat(rules.slice(8, 12), rules.slice(13, 14)), css: [rules[7]], js: rules.slice(3, 8).concat(rules.slice(12, 13), rules.slice(14)) }
};

function groupFor(result, term, label) {
  const root = result.roots.find(x => x.term === term);
  assert.ok(root, `не найден корень ${term}`);
  const group = root.children.find(x => x.group && x.label === label);
  assert.ok(group, `у ${term} нет группы «${label}»`);
  return group;
}

test('общий парсер распознаёт все типы правил структуры', () => {
  const parsed = StructureRules.parse(rules.join('\n'));
  const verbs = new Set(parsed.rules.map(r => r.verb));
  for (const verb of ['внутри','не внутри','не содержит','содержит','первым в','после','требует','пишется','связывает','читает','обязательно','можно','значения','заметка']) {
    assert.ok(verbs.has(verb), `парсер должен распознавать «${verb}»`);
  }
  assert.equal(parsed.bad.length, 0);
  assert.equal(StructureRules.parse('try: можно содержать catch, finally').rules[0].verb, 'содержит');
});

test('дерево использует общий парсер для вложенности и обратных связей', () => {
  const result = buildVariants({ q: 'ul', lang: 'html', dict, rows: [], synonyms: {} });
  const group = groupFor(result, 'ul', 'Состав конструкции');
  assert.ok(group.children.some(x => x.term === 'li'));
});

test('ограничения не смешиваются с допустимым составом', () => {
  const result = buildVariants({ q: 'p', lang: 'html', dict, rows: [], synonyms: {} });
  const group = groupFor(result, 'p', 'Запрещённое содержимое');
  assert.ok(group.children.some(x => /div/.test(x.show)));
  assert.equal(result.roots.find(x => x.term === 'p').children.some(x => x.label === 'Состав конструкции'), false);
  const inverse = buildVariants({ q: 'div', lang: 'html', dict, rows: [], synonyms: {} });
  const inverseGroup = groupFor(inverse, 'div', 'Запрещённое содержимое');
  assert.ok(inverseGroup.children.some(x => x.term === 'p'));
});

test('правило первого элемента имеет отдельный тип отношения', () => {
  const result = buildVariants({ q: 'summary', lang: 'html', dict, rows: [], synonyms: {} });
  const group = groupFor(result, 'summary', 'Порядок элементов');
  assert.ok(group.children.some(x => x.term === 'details'));
});

test('требования, обязательные части, необязательные части и значения разделены', () => {
  const required = buildVariants({ q: 'img', lang: 'html', dict, rows: [], synonyms: {} });
  groupFor(required, 'img', 'Обязательные части');
  groupFor(required, 'img', 'Допустимые части');
  const values = buildVariants({ q: 'button[type]', lang: 'html', dict, rows: [], synonyms: {} });
  const group = groupFor(values, 'button[type]', 'Допустимые значения');
  assert.ok(group.children.some(x => /submit/.test(x.show)));
});

test('связи между языками сохраняются как отдельные описанные отношения', () => {
  const result = buildVariants({ q: 'id', lang: 'html', dict, rows: [], synonyms: {} });
  const group = groupFor(result, 'id', 'Связи с другими языками');
  assert.ok(group.children.some(x => x.lang === 'css' && /#\\*/.test(x.show)));
  assert.ok(group.children.some(x => x.lang === 'js' && /getElementById/.test(x.show)));
});

test('запрет контекста, зависимости, чтение данных и заметка имеют свои типы', () => {
  const forbidden = buildVariants({ q: 'unsafe', lang: 'js', dict, rows: [], synonyms: {} });
  groupFor(forbidden, 'unsafe', 'Запрещённое расположение');
  const dependency = buildVariants({ q: 'gap', lang: 'css', dict, rows: [], synonyms: {} });
  const required = groupFor(dependency, 'gap', 'Зависимости');
  assert.ok(required.children.some(x => /display: flex \\| grid/.test(x.show)));
  const reader = buildVariants({ q: 'reader', lang: 'js', dict, rows: [], synonyms: {} });
  const reads = groupFor(reader, 'reader', 'Читаемые данные');
  assert.ok(reads.children.some(x => /fetch/.test(x.show)));
  const header = buildVariants({ q: 'header', lang: 'html', dict, rows: [], synonyms: {} });
  const notes = groupFor(header, 'header', 'Пояснения');
  assert.ok(notes.children.some(x => /семантическая шапка/.test(x.show)));
});

test('правило «содержит» не превращается в правило «после»', () => {
  const result = buildVariants({ q: 'try', lang: 'js', dict, rows: [], synonyms: {} });
  groupFor(result, 'try', 'Состав конструкции');
  assert.equal(result.roots.find(x => x.term === 'try').children.some(x => x.label === 'Следует после'), false);
});

test('длинное описание задачи находит конструкции по разным смысловым фразам', () => {
  const result = buildVariants({
    q: 'добавить кнопку которая показывает сообщение при нажатии',
    dict, rows: [],
    synonyms: { button: ['кнопка'], alert: ['сообщение'], addEventListener: ['нажатие'] }
  });
  const terms = new Set(result.roots.map(x => x.term));
  assert.ok(terms.has('button'));
  assert.ok(terms.has('alert'));
  assert.ok(terms.has('addeventlistener'));
});

test('шаблон синтаксиса берётся из общего парсера', () => {
  const result = buildVariants({ q: 'if', lang: 'js', dict, rows: [], synonyms: {} });
  const root = result.roots.find(x => x.term === 'if');
  assert.ok(root);
  assert.match(root.code, /if/);
  assert.ok(root.code.includes('\n'));
});

test('команда удаления не отображается как отношение дерева', () => {
  const parsed = StructureRules.parse('legacy: удалить');
  assert.equal(parsed.rules[0].verb, 'удалить');
  const result = buildVariants({ q: 'ul', lang: 'html', dict, rows: [], synonyms: {} });
  assert.equal(result.roots.some(root => root.children.some(child => child.relation === 'удалить')), false);
});
