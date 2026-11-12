import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { buildVariants } from '../lib/variant-tree.mjs';

const require = createRequire(import.meta.url);
const StructureRules = require('../public/structure-rules.js');
const baseDictionary = JSON.parse(fs.readFileSync(new URL('../public/keyword-dict.json', import.meta.url), 'utf8'));

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
      id: 'идентификатор', header: 'шапка страницы', script: 'скрипт', button: 'кнопка',
      'meta[name]': 'метатег с именем', content: 'содержимое метатега'
    },
    css: {
      gap: 'расстояние между элементами', display: 'тип раскладки элемента',
      'justify-content': 'выравнивание по главной оси', 'align-items': 'выравнивание по поперечной оси',
      'flex-direction': 'направление главной оси', 'grid-template-columns': 'колонки сетки',
      flex: 'flex-раскладка', grid: 'grid-раскладка',
      'animation-name': 'имя анимации', 'animation-duration': 'длительность анимации', '#*': 'селектор по id'
    },
    js: {
      if: 'условная конструкция', elif: 'дополнительное условие',
      try: 'обработка ошибок', catch: 'перехват ошибки', finally: 'завершение',
      await: 'ожидание операции', unsafe: 'условная конструкция',
      reader: 'чтение данных', fetch: 'сетевой запрос', alert: 'показать сообщение', addeventlistener: 'подписка на событие'
    }
  },
  words: { getelementbyid: 'поиск элемента' },
  structure: { html: rules.slice(0, 3).concat(rules.slice(8, 12), rules.slice(13, 14), ['meta[name]: требует content']), css: [rules[7], 'justify-content: требует display: flex | grid', 'align-items: требует display: flex | grid', 'flex-direction: требует display: flex', 'grid-template-columns: требует display: grid', 'animation-name: требует animation-duration'], js: rules.slice(3, 8).concat(rules.slice(12, 13), rules.slice(14)) }
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

test('правило «после» показывает предшествующие конструкции отдельным отношением', () => {
  const result = buildVariants({ q: 'elif', lang: 'js', dict, rows: [], synonyms: {} });
  const group = groupFor(result, 'elif', 'Предшествующие конструкции');
  assert.ok(group.children.some(x => x.term === 'if'));
  assert.ok(group.children.some(x => x.term === 'elif'));
});

test('шаблон «пишется» не теряется при построении узла', () => {
  const result = buildVariants({ q: 'if', lang: 'js', dict, rows: [], synonyms: {} });
  const root = result.roots.find(x => x.term === 'if');
  assert.ok(root);
  assert.match(root.code, /if/);
  assert.match(root.code, /\n/);
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
  const result = buildVariants({ q: 'id', lang: 'html', dict: { ...dict, words: baseDictionary.words }, rows: [], synonyms: {} });
  const group = groupFor(result, 'id', 'Связи с другими языками');
  assert.ok(group.children.some(x => x.lang === 'css' && /#\\*/.test(x.show)));
  assert.ok(group.children.some(x => x.lang === 'css' && x.term === '#*'), 'CSS-цель должна быть узлом, а не только текстом');
  assert.ok(group.children.some(x => x.lang === 'js' && /getElementById/.test(x.show)));
  assert.ok(group.children.some(x => x.lang === 'js' && x.term === 'getelementbyid'), 'JS-вызов должен вести к словарному узлу метода');
  const jsMethod = group.children.find(x => x.lang === 'js' && x.term === 'getelementbyid');
  assert.match(jsMethod.note, /находит один элемент по точному значению id/);
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
  assert.ok(reads.children.some(x => x.term === 'fetch' && x.lang === 'js'), 'источник чтения должен вести к узлу fetch');
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


test('совпадение слова внутри HTML-конструкции не создаёт несуществующий отдельный элемент', () => {
  const html = {
    ...dict,
    langs: {
      ...dict.langs,
      html: { ...dict.langs.html, '<div role="alert">': 'область для сообщения об ошибке' }
    }
  };
  const result = buildVariants({
    q: 'показать сообщение',
    lang: 'html',
    dict: html,
    rows: [],
    synonyms: { alert: ['показать сообщение'] }
  });
  assert.ok(result.roots.some(x => x.term === '<div role="alert">'));
  assert.equal(result.roots.some(x => x.term === 'alert'), false);
});

test('синонимы HTML-тега находят словарную запись с угловыми скобками', () => {
  const tagged = {
    ...dict,
    langs: {
      ...dict.langs,
      html: { ...dict.langs.html, '<aside>': 'обозначает боковую панель страницы' }
    }
  };
  const result = buildVariants({
    q: 'свернуть боковую панель',
    lang: 'html',
    dict: tagged,
    rows: [],
    synonyms: { '<aside>': ['боковая панель'] }
  });
  const root = result.roots.find(x => x.term === '<aside>');
  assert.ok(root);
  assert.equal(root.code, '<aside>');
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


test('SQL function signatures are available through the shared structure rules', () => {
  const sqlRules = StructureRules.parse([
    'coalesce: обязательно expression, fallback — два или больше выражений; возвращает первое не NULL',
    'substring: обязательно text, start',
    'substring: можно length',
    'round: обязательно numeric',
    'round: можно precision'
  ].join('\n'));
  assert.equal(sqlRules.bad.length, 0);
  const coalesce = StructureRules.attrsFor('COALESCE', sqlRules.rules);
  assert.deepEqual(coalesce.required.map(item => item.name), ['expression', 'fallback']);
  assert.match(coalesce.required[0].note, /первое не NULL/);
  const substring = StructureRules.attrsFor('substring', sqlRules.rules);
  assert.deepEqual(substring.required.map(item => item.name), ['text', 'start']);
  assert.deepEqual(substring.optional.map(item => item.name), ['length']);
  const round = StructureRules.attrsFor('round', sqlRules.rules);
  assert.deepEqual(round.required.map(item => item.name), ['numeric']);
  assert.deepEqual(round.optional.map(item => item.name), ['precision']);
});

test('CSS dependency points to the required property and preserves its allowed values', () => {
  const result = buildVariants({ q: 'gap', lang: 'css', dict, rows: [], synonyms: {} });
  const group = groupFor(result, 'gap', 'Зависимости');
  const display = group.children.find(x => x.term === 'display');
  assert.ok(display, 'gap must link to the actionable display property');
  assert.match(display.code, /^display:/);
  assert.match(display.show, /^display: flex \| grid$/);
});

test('CSS dependency is navigable in reverse from display to dependent properties', () => {
  const result = buildVariants({ q: 'display', lang: 'css', dict, rows: [], synonyms: {} });
  const group = groupFor(result, 'display', 'Зависимые свойства');
  const terms = new Set(group.children.map(x => x.term));
  for (const term of ['gap', 'justify-content', 'align-items', 'flex-direction', 'grid-template-columns']) {
    assert.ok(terms.has(term), 'display must link back to dependent property ' + term);
  }
  const gap = group.children.find(x => x.term === 'gap');
  assert.match(gap.show, /requires|требует/);
  assert.match(gap.show, /flex \| grid/);
});

test('CSS requirements without a value qualifier are navigable in both directions', () => {
  const forward = buildVariants({ q: 'animation-name', lang: 'css', dict, rows: [], synonyms: {} });
  const required = groupFor(forward, 'animation-name', 'Зависимости');
  assert.ok(required.children.some(x => x.term === 'animation-duration'));

  const reverse = buildVariants({ q: 'animation-duration', lang: 'css', dict, rows: [], synonyms: {} });
  const dependents = groupFor(reverse, 'animation-duration', 'Зависимые свойства');
  assert.ok(dependents.children.some(x => x.term === 'animation-name'));
});

test('plain requirements are navigable in reverse for HTML too', () => {
  const result = buildVariants({ q: 'content', lang: 'html', dict, rows: [], synonyms: {} });
  const group = groupFor(result, 'content', 'Зависимые конструкции');
  assert.ok(group.children.some(x => x.term === 'meta[name]'));
});

test('CSS requirement values expose only dependents compatible with the selected value', () => {
  const flex = buildVariants({ q: 'flex', lang: 'css', dict, rows: [], synonyms: {} });
  const group = groupFor(flex, 'flex', 'Свойства для значения «flex»');
  const terms = new Set(group.children.map(x => x.term));
  assert.ok(terms.has('gap'));
  assert.ok(terms.has('flex-direction'));
  assert.ok(!terms.has('grid-template-columns'));
});
