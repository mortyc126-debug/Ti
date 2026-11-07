import test from 'node:test';
import assert from 'node:assert/strict';
import { combineTaskSearch, inferTaskScope } from '../lib/search-core.mjs';

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
      { id: 'exact-title', title: 'Ссылка на другую страницу', lang: 'html', why: [{ kind: 'exact', in: 'название' }] }
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


test('язык активного файла мягко повышает релевантные фрагменты, не скрывая остальные языки', () => {
  const result = combineTaskSearch({
    query: 'найти и показать данные',
    language: 'python',
    directed: { hits: [], rankedPieces: [
      { id: 'js-piece', title: 'JavaScript fragment', lang: 'javascript', targetKey: 'fetch' },
      { id: 'py-piece', title: 'Python fragment', lang: 'python', targetKey: 'requests' }
    ] },
    library: { hits: [
      { id: 'js-piece', title: 'JavaScript fragment', lang: 'javascript' },
      { id: 'py-piece', title: 'Python fragment', lang: 'python' }
    ] },
    variants: { roots: [] }
  });

  assert.equal(result.pieces[0].id, 'py-piece', 'совпадающий язык должен получить небольшой контекстный приоритет');
  assert.deepEqual(new Set(result.pieces.map(piece => piece.id)), new Set(['js-piece', 'py-piece']));
  assert.equal(result.pieces[0].contextBoost, 'язык активного файла');
  assert.ok(result.pieces[0].why.some(reason => reason.source === 'контекст'));
  assert.equal(result.pieces.find(piece => piece.id === 'js-piece').contextBoost, null);
});

test('пустой список matchedTargets не теряет связь с единственной найденной конструкцией', () => {
  const result = combineTaskSearch({
    query: 'кнопка',
    directed: { hits: [], rankedPieces: [
      { id: 'button-piece', title: 'Кнопка', lang: 'html', targetKey: 'button', matchedTargets: [] }
    ] },
    library: { hits: [] },
    variants: { roots: [] }
  });
  assert.deepEqual(result.pieces[0].matchedTargets, ['button']);
  assert.deepEqual(result.pieces[0].why[0].targets, ['button']);
});


test('цель, отсутствующая среди ограниченных корней дерева, сохраняет термин и язык', () => {
  const result = combineTaskSearch({
    query: 'получить данные из двух источников',
    directed: {
      hits: [{
        targetKey: 'Promise.all', score: 47, phrases: [{ phrase: 'дождаться всех источников данных' }],
        pieces: [{ id: 'promise-piece', lang: 'js' }]
      }],
      rankedPieces: [{ id: 'promise-piece', title: 'Дождаться нескольких запросов', lang: 'js', targetKey: 'Promise.all' }]
    },
    library: { hits: [] },
    variants: { roots: [] }
  });
  assert.equal(result.targets[0].rootTerm, 'Promise.all');
  assert.equal(result.targets[0].rootLang, 'js');
  assert.equal(result.pieces[0].matchedTargets[0], 'Promise.all');
});


test('фрагменты и связи восстанавливаются из целей, если агрегированный список пуст', () => {
  const result = combineTaskSearch({
    query: 'получить данные из двух источников',
    directed: {
      hits: [{
        targetKey: 'fetch', score: 56, phrases: [{ phrase: 'получить данные из нескольких источников' }],
        pieces: [{ id: 'fetch-piece', title: 'fetch + await', lang: 'js', desc: 'Получить данные из источника' }]
      }],
      rankedPieces: []
    },
    library: { hits: [] },
    variants: { roots: [] }
  });
  assert.equal(result.counts.directedPieces, 1);
  assert.equal(result.pieces[0].id, 'fetch-piece');
  assert.deepEqual(result.pieces[0].matchedTargets, ['fetch']);
});


test('одноимённая цель сохраняет язык лучшего корня, а не случайного примера', () => {
  const result = combineTaskSearch({
    query: 'подсветить текст при наведении',
    directed: {
      hits: [{
        targetKey: 'color', score: 52, phrases: [{ phrase: 'изменить цвет текста при наведении' }],
        pieces: [{ id: 'color-js-example', title: 'JS fallback', lang: 'js' }]
      }],
      rankedPieces: []
    },
    library: { hits: [] },
    variants: { roots: [
      { term: 'color', lang: 'css', score: 5.6, label: 'CSS-свойство' },
      { term: 'color', lang: 'html', score: 5.1, label: 'одноимённый HTML-корень' }
    ] }
  });
  assert.equal(result.targets[0].rootLang, 'css');
});


test('резервная сборка сохраняет порядок целей и фрагментов внутри цели', () => {
  const result = combineTaskSearch({
    query: 'получить данные из двух источников',
    directed: {
      hits: [
        { targetKey: 'fetch', score: 56, pieces: [
          { id: 'fetch-a', title: 'fetch A', lang: 'js', position: 99 },
          { id: 'fetch-b', title: 'fetch B', lang: 'js', position: 1 }
        ] },
        { targetKey: 'Promise.all', score: 47, pieces: [
          { id: 'promise-all', title: 'Promise.all', lang: 'js', position: 0 }
        ] }
      ],
      rankedPieces: []
    },
    library: { hits: [] },
    variants: { roots: [] }
  });
  assert.deepEqual(result.pieces.map(piece => piece.id), ['fetch-a', 'fetch-b', 'promise-all']);
});


test('языковой алиас javascript не отбрасывается из веб-задачи', () => {
  const result = combineTaskSearch({
    query: 'кнопка по нажатию показывает сообщение',
    directed: { hits: [], rankedPieces: [
      { id: 'js-alias', title: 'Обработчик клика', lang: 'javascript' }
    ] },
    library: { hits: [] },
    variants: { roots: [] }
  });
  assert.equal(result.counts.directedPieces, 1);
  assert.equal(result.pieces[0].lang, 'js');
});


test('общий фрагмент сохраняет все цели и лучший ранг при резервном объединении', () => {
  const result = combineTaskSearch({
    query: 'получить данные из двух источников',
    directed: {
      hits: [
        { targetKey: 'fetch', score: 40, pieces: [
          { id: 'shared', title: 'Общий пример', lang: 'js', relevanceScore: 3 }
        ] },
        { targetKey: 'Promise.all', score: 60, pieces: [
          { id: 'shared', title: 'Общий пример', lang: 'js', relevanceScore: 8 }
        ] }
      ],
      rankedPieces: []
    },
    library: { hits: [] },
    variants: { roots: [] }
  });
  assert.deepEqual(result.pieces[0].matchedTargets, ['fetch', 'Promise.all']);
  assert.equal(result.pieces[0].why.find(reason => reason.source === 'направленные фразы')?.targetScore, 60);
});


test('языковая область фильтруется до лимита, а не после него', () => {
  const result = combineTaskSearch({
    query: 'кнопка по нажатию',
    limit: 1,
    directed: { hits: [], rankedPieces: [
      { id: 'python-first', title: 'Python unrelated', lang: 'python', position: 1 },
      { id: 'js-second', title: 'JavaScript click handler', lang: 'js', position: 2 }
    ] },
    library: { hits: [] },
    variants: { roots: [] }
  });
  assert.equal(result.pieces.length, 1);
  assert.equal(result.pieces[0].id, 'js-second');
});


test('не подменяет вывод итога арифметической операцией без запроса на сумму', () => {
  const search = query => combineTaskSearch({
    query,
    directed: {
      hits: [{ targetKey: 'sum', score: 40, pieces: [{ id: 'sum-piece', title: 'SUM', lang: 'html' }] }],
      rankedPieces: [{ id: 'sum-piece', title: 'SUM', lang: 'html', targetKey: 'sum' }]
    },
    library: { hits: [] },
    variants: { roots: [] }
  });
  const display = search('Получить данные из двух источников и вывести итог внизу страницы');
  assert.equal(display.targets.some(x => x.targetKey === 'sum'), false);
  assert.equal(display.pieces.some(x => (x.matchedTargets || []).includes('sum')), false);
  const arithmetic = search('Получить данные из двух источников, сложить значения и вывести сумму на страницу');
  assert.equal(arithmetic.targets.some(x => x.targetKey === 'sum'), true);
});

test('связанные фрагменты выше несвязанных лексических совпадений, но запасные результаты сохраняются', () => {
  const result = combineTaskSearch({
    query: 'сделать надпись ссылкой на другую страницу',
    directed: {
      hits: [{ targetKey: 'href', score: 48, pieces: [{ id: 'href-piece', title: 'Ссылка на другую страницу', lang: 'html' }] }],
      rankedPieces: [{ id: 'href-piece', title: 'Ссылка на другую страницу', lang: 'html', targetKey: 'href', position: 1, matchedTargets: ['href'] }]
    },
    library: { hits: [
      { id: 'unrelated-1', title: 'Контактные сведения', lang: 'html' },
      { id: 'unrelated-2', title: 'Содержимое каталога с типами элементов', lang: 'js' }
    ] },
    variants: { roots: [{ term: 'a', lang: 'html' }] }
  });
  assert.equal(result.pieces[0].id, 'href-piece');
  assert.ok(result.pieces.some(piece => piece.id === 'unrelated-1'));
  assert.ok(result.pieces.findIndex(piece => piece.id === 'unrelated-1') > 0);
});


test('для вывода данных не подменяет textContent читающим innerText', () => {
  const result = combineTaskSearch({
    query: 'получить данные из двух источников и вывести имя в шапку',
    directed: {
      hits: [
        { targetKey: 'innerText', score: 60, pieces: [{ id: 'read-text', title: 'Прочитать отображаемый текст', lang: 'js' }] },
        { targetKey: 'textContent', score: 52, pieces: [{ id: 'write-text', title: 'Вывести текст в элемент', lang: 'js' }] }
      ],
      rankedPieces: [
        { id: 'read-text', title: 'Прочитать отображаемый текст', lang: 'js', targetKey: 'innerText', position: 1 },
        { id: 'write-text', title: 'Вывести текст в элемент', lang: 'js', targetKey: 'textContent', position: 2 }
      ]
    },
    library: { hits: [] },
    variants: { roots: [{ term: 'innerText', lang: 'js' }, { term: 'textContent', lang: 'js' }] }
  });
  assert.deepEqual(result.targets.map(target => target.targetKey), ['textContent']);
  assert.ok(!result.roots.some(root => String(root.term).toLowerCase() === 'innertext'));
  assert.ok(result.pieces.some(piece => piece.id === 'write-text'));
  assert.ok(!result.pieces.some(piece => piece.id === 'read-text'));
});


test('область задачи распознаёт веб-сборку и не путает её с задачей по массивам', () => {
  assert.equal(inferTaskScope('Добавить кнопку, которая показывает сообщение при нажатии'), 'web');
  assert.equal(inferTaskScope('Свернуть массив в одно значение'), '');
  assert.equal(inferTaskScope('Python: получить элемент списка'), '');
});
