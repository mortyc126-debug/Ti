import test from 'node:test';
import assert from 'node:assert/strict';
import { combineTaskSearch } from '../lib/search-core.mjs';

test('объединяет направленные фразы и полнотекстовые фрагменты без потери источников', () => {
  const result = combineTaskSearch({
    query: 'добавить кнопку и обработчик нажатия',
    language: 'html',
    limit: 10,
    directed: {
      ambiguous: false,
      hits: [{ targetKey: 'button', score: 80, phrases: [{ phrase: 'кнопка', match: { matchedTokens: ['кнопк'] } }], sections: ['html'], pieces: [{ id: 'both', lang: 'html' }] }],
      rankedPieces: [
        { id: 'both', title: 'Кнопка с действием', lang: 'html', targetKey: 'button', targetScore: 80, matchedTargets: ['button'] },
        { id: 'phrase-only', title: 'Нажатие кнопки', lang: 'js', targetKey: 'addEventListener', targetScore: 70 }
      ]
    },
    library: {
      hits: [
        { id: 'both', title: 'Кнопка с действием', lang: 'html', group: 'HTML: формы', why: [{ q: 'кнопка', kind: 'exact' }] },
        { id: 'text-only', title: 'Обработчик события', lang: 'js', group: 'JavaScript: события', why: [{ q: 'обработчик', kind: 'syn' }] }
      ]
    },
    variants: { roots: [{ term: 'button', lang: 'html', children: [] }] }
  });

  assert.equal(result.mode, 'task');
  assert.equal(result.targets[0].rootTerm, 'button');
  assert.deepEqual(result.pieces.map(piece => piece.id), ['both', 'phrase-only', 'text-only']);
  assert.deepEqual(result.pieces[0].sources, ['направленные фразы', 'полнотекстовый поиск']);
  assert.equal(result.pieces[0].matchedTargets[0], 'button');
  assert.equal(result.counts.pieces, 3);
});

test('в задачах интерфейса приоритет у веб-языков, но явный backend-запрос сохраняет Python', () => {
  const web = combineTaskSearch({
    query: 'свернуть боковую панель',
    directed: { hits: [{ targetKey: 'reduce', pieces: [{ id: 'py', lang: 'python' }] }], rankedPieces: [
      { id: 'aside', title: 'Боковая панель', lang: 'html' },
      { id: 'reduce', title: 'Свёртка массива', lang: 'python' }
    ] },
    library: { hits: [
      { id: 'aside', title: 'Боковая панель', lang: 'html' },
      { id: 'reduce', title: 'Свёртка массива', lang: 'python' }
    ] },
    variants: { roots: [
      { term: 'aside', lang: 'html' },
      { term: 'reduce', lang: 'python' }
    ] }
  });
  assert.deepEqual(web.roots.map(x => x.lang), ['html']);
  assert.deepEqual(web.pieces.map(x => x.id), ['aside']);
  assert.equal(web.targets.length, 0);

  const backend = combineTaskSearch({
    query: 'получить данные из Python backend и вывести их на страницу',
    directed: { hits: [], rankedPieces: [{ id: 'py', title: 'Python API', lang: 'python' }] },
    library: { hits: [] },
    variants: { roots: [{ term: 'fetch', lang: 'js' }, { term: 'python', lang: 'python' }] }
  });
  assert.deepEqual(backend.roots.map(x => x.lang), ['js', 'python']);
  assert.equal(backend.pieces[0].lang, 'python');
});

test('точное совпадение с названием фрагмента выше слабого совпадения по фразе', () => {
  const result = combineTaskSearch({
    query: 'сделать надпись ссылкой на другую страницу',
    directed: { hits: [], rankedPieces: [
      { id: 'weak', title: 'Вставить HTML рядом с элементом', lang: 'js', targetKey: 'insertAdjacentHTML' }
    ] },
    library: { hits: [
      { id: 'exact-title', title: 'Ссылка на другую страницу', lang: 'html', why: [{ kind: 'exact', in: 'название/описание' }] }
    ] },
    variants: { roots: [] }
  });
  assert.equal(result.pieces[0].id, 'exact-title');
});

test('объясняет результаты, найденные только одним источником', () => {
  const result = combineTaskSearch({
    query: 'отступ',
    directed: { hits: [], rankedPieces: [] },
    library: { hits: [{ id: 'margin', title: 'Внешний отступ', why: [{ q: 'отступ', kind: 'syn' }] }] },
    variants: { roots: [] }
  });
  assert.deepEqual(result.pieces[0].sources, ['полнотекстовый поиск']);
  assert.equal(result.pieces[0].why[0].source, 'полнотекстовый поиск');
});

console.log('search-core: source fusion tests passed');
