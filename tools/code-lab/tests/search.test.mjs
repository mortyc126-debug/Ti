// Тесты поиска. Запуск: node tools/code-lab/tests/search.test.mjs
import assert from 'node:assert/strict';
import { stemRu, stemEn } from '../lib/ru-stem.mjs';
import { buildIndex, terms } from '../lib/search.mjs';

let n = 0;
const test = (name, fn) => { try { fn(); n++; } catch (e) { e.message = `[${name}] ` + e.message; throw e; } };

test('основы слов: формы одного слова сходятся', () => {
  const same = g => assert.equal(new Set(g.map(stemRu)).size, 1, g.join(', '));
  same(['толщина', 'толщину', 'толщины', 'толщиной']);
  same(['жирный', 'жирного', 'жирным', 'жирнее', 'жирные']);
  same(['шрифт', 'шрифты', 'шрифтов', 'шрифта']);
  same(['цикл', 'циклы', 'циклов', 'циклом']);
  same(['случайный', 'случайное', 'случайные', 'случайного']);
  assert.notEqual(stemRu('толщина'), stemRu('цвет'));
  assert.equal(stemRu('ёж'), stemRu('еж'));
  assert.equal(stemEn('fonts'), 'font'); assert.equal(stemEn('looping'), 'loop'); assert.equal(stemEn('string'), 'string');
});

test('слова из кода режутся на части', () => {
  assert.deepEqual(terms('font-weight'), ['font-weight', 'font', 'weight']);
  assert.ok(terms('querySelector').includes('query') && terms('querySelector').includes('selector') && terms('querySelector').includes('queryselector'));
  assert.ok(terms('grid-template-columns').includes('grid-template-columns') && terms('grid-template-columns').includes('template'));
});

const docs = [
  { id: 'bold', title: 'жирный', desc: 'Делает текст жирным', group: 'CSS: текст и шрифты / Начертание', code: 'p { font-weight: 700; }', notes: ['font-weight — жирность шрифта (normal, bold, 700).'], tags: [], aliases: [], extra: [], output: '' },
  { id: 'italic', title: 'курсив', desc: 'Наклонный текст', group: 'CSS: текст и шрифты / Начертание', code: 'p { font-style: italic; }', notes: [], tags: [], aliases: [], extra: [], output: '' },
  { id: 'size', title: 'размер шрифта', desc: 'Меняет размер букв', group: 'CSS: текст и шрифты / Шрифт и размер', code: 'p { font-size: 18px; }', notes: [], tags: [], aliases: [], extra: [], output: '' },
  { id: 'loop', title: 'цикл for', desc: 'Повторяет действие несколько раз', group: 'Основы', code: 'for i in range(3):\n    print(i)', notes: [], tags: [], aliases: [], extra: [], output: '' },
  { id: 'arr', title: 'массив', desc: 'Список значений', group: 'Данные', code: 'const список = [1, 2, 3];', notes: [], tags: ['коллекция'], aliases: [], extra: [], output: '' },
  { id: 'qs', title: 'найти элемент', desc: 'Находит узел на странице', group: 'Интерфейс', code: 'document.querySelector(".card")', notes: [], tags: [], aliases: [], extra: [], output: '' },
  { id: 'rnd', title: 'случайное число', desc: 'Число от 0 до 1', group: 'Числа', code: 'Math.random()', notes: [], tags: [], aliases: [], extra: [], output: '' }
];
const synonyms = { groups: [['толщина', 'жирность', 'жирный', 'bold', 'weight', 'font-weight'], ['массив', 'список', 'array', 'list']] };
const ix = buildIndex(docs, { synonyms });
const ids = (q, o) => ix.search(q, o).hits.map(h => h.id);

test('поиск по коду, которого нет в названии и описании', () => {
  assert.equal(ids('font-weight')[0], 'bold');
  assert.ok(ids('querySelector').includes('qs'));
  assert.ok(ids('range').includes('loop'));
});

test('словоформы: «толщину» находит «толщина»', () => {
  assert.ok(ids('жирности')[0] === 'bold');
  assert.ok(ids('шрифтов').includes('size'));
});

test('синонимы: «толщина букв» находит «жирный», хотя слова «толщина» нигде нет', () => {
  const r = ix.search('толщина букв');
  assert.equal(r.hits[0].id, 'bold');
  const why = r.hits[0].why.find(w => w.q === 'толщина');
  assert.ok(why && why.kind === 'syn');
});

test('синоним из другого языка и из кода', () => {
  assert.equal(ids('bold')[0], 'bold');
  assert.ok(ids('list').includes('arr'));
  assert.ok(ids('array').includes('arr'));
});

test('теги участвуют в поиске', () => assert.ok(ids('коллекция').includes('arr')));

test('начало слова и опечатки', () => {
  assert.ok(ids('жирн').includes('bold'));
  assert.ok(ids('шрифт').length >= 2);
  assert.ok(ids('rando').includes('rnd'));
  assert.ok(ids('curсив').length === 0 || true);   // смешанная раскладка не должна падать
  assert.ok(ids('кусив').includes('italic') || ids('курссив').includes('italic'));   // одна опечатка
});

test('понятное выше: слова в коротком названии важнее частых упоминаний в описании и коде; свой язык выше', () => {
  const d2 = [
    { id: 'long', title: 'Проверить видимость узла на странице с учётом стилей и прокрутки', desc: 'Находит элемент, проверяет элемент, элемент виден ли элемент', group: 'DOM', code: Array(25).fill('el.checkVisibility(); // элемент').join('\n'), notes: ['элемент'], tags: ['элемент'], aliases: [], extra: [], output: '', lang: 'js' },
    { id: 'qs', title: 'querySelector — найти элемент', desc: 'Первый подходящий узел', group: 'DOM', code: 'document.querySelector(".card")', notes: [], tags: [], aliases: [], extra: [], output: '', lang: 'js' },
    { id: 'py', title: 'найти элемент в списке', desc: '', group: 'Данные', code: 'x in items', notes: [], tags: [], aliases: [], extra: [], output: '', lang: 'python' }
  ];
  const ix2 = buildIndex(d2);
  const order = ix2.search('найти элемент').hits.map(h => h.id);
  assert.ok(order.indexOf('qs') < order.indexOf('long'), 'короткий со словами в названии выше длинного: ' + order);
  assert.equal(ix2.search('найти элемент', { lang: 'js' }).hits[0].id, 'qs');
  assert.equal(ix2.search('найти элемент', { lang: 'python' }).hits[0].id, 'py');
  assert.ok(ix2.search('найти элемент').hits.some(h => h.id === 'long'), 'длинный не выкидывается, а просто ниже');
});

test('лишние слова вопроса не ломают выдачу', () => {
  assert.equal(ids('как сделать текст жирным')[0], 'bold');
});

test('всё, что находил старый поиск по подстроке, находится и сейчас', () => {
  for (const q of ['цикл', 'ци', 'массив', 'число от', 'Наклонный', 'ра']) {
    const old = docs.filter(d => (d.title + ' ' + d.desc).toLowerCase().includes(q.toLowerCase())).map(d => d.id);
    const now = ids(q);
    for (const id of old) assert.ok(now.includes(id), `«${q}» потерял ${id}`);
  }
});

test('каждый результат объясняет, почему найден', () => {
  for (const h of ix.search('шрифт').hits) assert.ok(h.why.length > 0);
  const w = ix.search('font-weight').hits[0].why[0];
  assert.equal(w.q, 'font-weight'); assert.ok(w.found && w.in);
});

test('пустой и бессмысленный запрос не падает', () => {
  assert.equal(ix.search('').total, 0);
  assert.equal(ix.search('   ').total, 0);
  assert.equal(ix.search('ъъъъъъъъ').total, 0);
  assert.doesNotThrow(() => ix.search('((( ]]] \\ ^$'));
});

test('однобуквенные слова и мусор не ломают поиск', () => {
  assert.doesNotThrow(() => ix.search('цикл — ф'));
  assert.ok(ids('цикл — ф').includes('loop'));
  assert.doesNotThrow(() => ix.search('ф'));
  assert.doesNotThrow(() => ix.search('1 2 3'));
});

console.log(`search: ${n} групп проверок пройдено`);
