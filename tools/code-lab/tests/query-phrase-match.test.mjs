import test from 'node:test';
import assert from 'node:assert/strict';
import { matchQueryPhrase, queryTokens } from '../lib/query-phrase-match.mjs';

test('длинный запрос сопоставляется с отдельными смысловыми фразами', () => {
  const query = 'добавить кнопку которая показывает сообщение при нажатии';
  assert.ok(matchQueryPhrase(query, 'кнопка'));
  assert.ok(matchQueryPhrase(query, 'показать сообщение'));
  assert.ok(matchQueryPhrase(query, 'слушать нажатие'));
});

test('точное совпадение выше частичного', () => {
  const exact = matchQueryPhrase('отступ внутри элемента', 'отступ внутри элемента');
  const partial = matchQueryPhrase('отступ внутри элемента', 'отступ внутри блока');
  assert.equal(exact.score, 100);
  assert.ok(partial && partial.score < exact.score);
});

test('отрицание не теряется при сопоставлении', () => {
  assert.equal(matchQueryPhrase('не скрывать элемент', 'скрыть элемент'), null);
  assert.equal(matchQueryPhrase('не скрыть элемент', 'скрыть элемент'), null);
  assert.equal(matchQueryPhrase('скрыть элемент', 'не скрывать элемент'), null);
  assert.ok(matchQueryPhrase('не скрывать элемент', 'не скрывать место'));
});

test('объект запроса снимает ложную неоднозначность между интерфейсом и массивом', () => {
  assert.equal(matchQueryPhrase('свернуть боковую панель', 'свернуть массив', '.reduce'), null);
  assert.equal(matchQueryPhrase('свернуть блок', 'свернуть массив', '.reduce'), null);
  assert.equal(matchQueryPhrase('свернуть массив', 'раскрывающийся блок', '<details>'), null);
  assert.equal(matchQueryPhrase('свернуть массив элементов', 'раскрывающийся блок', '<details>'), null);
  assert.ok(matchQueryPhrase('свернуть блок', 'раскрывающийся блок', '<details>'));
  assert.ok(matchQueryPhrase('сделать блок который можно раскрыть и свернуть', 'раскрывающийся блок', '<details>'));
});

test('контрастные уточнения не смешиваются при частичном совпадении', () => {
  assert.equal(matchQueryPhrase('отступ внутри элемента', 'отступ снаружи элемента'), null);
  assert.equal(matchQueryPhrase('отступ внутри элемента', 'отступ'), null);
  assert.equal(matchQueryPhrase('толщина шрифта', 'размер шрифта'), null);
  assert.equal(matchQueryPhrase('межбуквенный интервал', 'межстрочный интервал'), null);
  assert.equal(matchQueryPhrase('спрятать элемент сохранив место', 'скрыть элемент из потока'), null);
  assert.equal(matchQueryPhrase('спрятать элемент сохранив место', 'скрыть элемент', 'display'), null);
  assert.equal(matchQueryPhrase('скрыть элемент из потока', 'спрятать без удаления места', 'visibility'), null);
  assert.equal(matchQueryPhrase('подсветить при наведении', 'действие при нажатии'), null);
  assert.equal(matchQueryPhrase('выровнять текст по центру', 'выровнять элементы по центру'), null);
});

test('контекст отступов не притягивает DOM API и оператор in', () => {
  assert.equal(matchQueryPhrase('отступ внутри элемента', 'вставить элемент внутрь', 'appendChild'), null);
  assert.equal(matchQueryPhrase('отступ внутри элемента', 'текст внутри элемента', 'textContent'), null);
  assert.equal(matchQueryPhrase('отступ внутри элемента', 'внутри списка', 'in'), null);
  assert.ok(matchQueryPhrase('оператор in для проверки вхождения в список', 'оператор in для проверки вхождения в список', 'in'));
  assert.ok(matchQueryPhrase('получить текст внутри элемента', 'текст внутри элемента', 'textContent'));
  assert.ok(matchQueryPhrase('добавить элемент внутрь контейнера', 'вставить элемент внутрь', 'appendChild'));
});

test('ссылка и кнопка не подменяют друг друга при совпадении действия', () => {
  assert.equal(matchQueryPhrase('ссылка по клику', 'действие по клику', '<button>'), null);
  assert.equal(matchQueryPhrase('кнопка', 'ссылка', 'href'), null);
  assert.equal(matchQueryPhrase('ссылка по клику', 'кнопка по клику'), null);
  assert.equal(matchQueryPhrase('кнопка', 'ссылка на страницу'), null);
});

test('короткое совпадение внутри другого слова не считается совпадением', () => {
  assert.equal(matchQueryPhrase('join', 'disjoint'), null);
  assert.equal(matchQueryPhrase('ступ', 'отступ внутри элемента'), null);
});

test('смысловые предлоги сохраняются в токенах', () => {
  const tokens = queryTokens('отступ внутри элемента без перезагрузки');
  assert.ok(tokens.includes('внутр'));
  assert.ok(tokens.includes('без'));
});

console.log('query-phrase-match: all tests passed');


test('одно общее существительное не связывает несопоставимые конструкции', () => {
  assert.equal(matchQueryPhrase('свернуть блок', 'таблица блоков', 'grid'), null);
  assert.equal(matchQueryPhrase('свернуть блок', 'высота блока', 'height'), null);
  assert.equal(matchQueryPhrase('сделать надпись ссылкой на другую страницу', 'текст как на странице', 'innerText'), null);
  assert.equal(matchQueryPhrase('подсветить текст заголовка в шапке при наведении', 'получить текст блока', 'textContent'), null);
  assert.ok(matchQueryPhrase('получить данные из двух источников', 'получить данные из нескольких источников', 'fetch'));
});
