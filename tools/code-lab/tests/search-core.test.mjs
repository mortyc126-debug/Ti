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

test('обычная навигационная ссылка не получает ложный CSS-корень href', () => {
  const result = combineTaskSearch({
    query: 'сделать ссылку на другую страницу',
    directed: { hits: [], rankedPieces: [] },
    library: { hits: [] },
    variants: { roots: [
      { term: 'a', lang: 'html' },
      { term: 'href', lang: 'html' },
      { term: 'href', lang: 'css' }
    ] }
  });
  assert.deepEqual(result.roots.map(root => [root.term, root.lang]), [
    ['a', 'html'],
    ['href', 'html']
  ]);
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
        targetKey: 'Promise.all', score: 47, phrases: [{ phrase: 'дождаться всех источников данных', language: 'js', note: 'Дождаться завершения всех запросов' }],
        pieces: [{ id: 'promise-piece', title: 'Дождаться нескольких запросов', desc: 'Пример с Promise.all', lang: 'js' }]
      }],
      rankedPieces: [{ id: 'promise-piece', title: 'Дождаться нескольких запросов', lang: 'js', targetKey: 'Promise.all' }]
    },
    library: { hits: [] },
    variants: { roots: [] }
  });
  assert.equal(result.targets[0].rootTerm, 'Promise.all');
  assert.equal(result.targets[0].rootLang, 'js');
  assert.equal(result.pieces[0].matchedTargets[0], 'Promise.all');
  const root = result.roots.find(item => item.targetKey === 'Promise.all');
  assert.ok(root, 'направленная цель, которой не было в исходном дереве, становится корнем');
  assert.equal(root.lang, 'js');
  assert.equal(root.note, 'Дождаться завершения всех запросов');
  assert.equal(root.children[0].piece, 'promise-piece');
  assert.equal(root.children[0].note, 'Пример с Promise.all');
});


test('направленные цели добавляются в дерево перед общей группой и сохраняют порядок и фрагменты', () => {
  const result = combineTaskSearch({
    query: 'получить данные из двух источников и вывести их по блокам',
    directed: {
      hits: [
        {
          targetKey: 'fetch', score: 56,
          phrases: [{ phrase: 'получить данные из нескольких источников', language: 'js', note: 'Выполнить запрос к источнику' }],
          pieces: [{ id: 'fetch-piece', title: 'Запрос к источнику', lang: 'js', desc: 'Получить данные с сервера' }]
        },
        {
          targetKey: 'Promise.all', score: 47,
          phrases: [{ phrase: 'дождаться всех источников данных', language: 'js' }],
          pieces: [{ id: 'promise-piece', title: 'Дождаться всех запросов', lang: 'js' }]
        }
      ],
      rankedPieces: []
    },
    library: { hits: [] },
    variants: { roots: [{ term: '', lang: 'js', group: true, label: 'куски из библиотеки', children: [] }] }
  });
  assert.deepEqual(result.roots.map(root => root.term), ['fetch', 'Promise.all', '']);
  assert.equal(result.roots[0].children[0].piece, 'fetch-piece');
  assert.equal(result.roots[0].note, 'Выполнить запрос к источнику');
  assert.equal(result.roots[1].children[0].piece, 'promise-piece');
  assert.deepEqual(result.targets.map(target => target.targetKey), ['fetch', 'Promise.all']);
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
  const colorRoots = result.roots.filter(root => root.term === 'color');
  assert.equal(colorRoots.length, 2, 'оба исходных одноимённых корня сохраняются без дубликата от directed-поиска');
  assert.equal(colorRoots[0].lang, 'css');
  assert.equal(colorRoots[0].children[0].piece, 'color-js-example');
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


test('не превращает обычную кнопку в форму и список данных в выпадающий select', () => {
  const button = combineTaskSearch({
    query: 'кнопка по нажатию показывает сообщение',
    directed: {
      hits: [
        { targetKey: '<button>', score: 48, pieces: [{ id: 'button', title: 'Кнопка', lang: 'html' }] },
        { targetKey: '<form>', score: 43, pieces: [{ id: 'form', title: 'Форма', lang: 'html' }] }
      ],
      rankedPieces: [
        { id: 'button', title: 'Кнопка', lang: 'html', targetKey: '<button>', position: 1 },
        { id: 'form', title: 'Форма', lang: 'html', targetKey: '<form>', position: 2 }
      ]
    },
    library: { hits: [] },
    variants: { roots: [{ term: 'button', lang: 'html' }, { term: 'form', lang: 'html' }] }
  });
  assert.deepEqual(button.targets.map(target => target.targetKey), ['<button>']);
  assert.ok(!button.roots.some(root => String(root.term).toLowerCase().includes('form')));

  const list = combineTaskSearch({
    query: 'получить данные из двух источников и вывести список в основной блок',
    directed: {
      hits: [
        { targetKey: '<ul>', score: 45, pieces: [{ id: 'ul', title: 'Список', lang: 'html' }] },
        { targetKey: '<select>', score: 39, pieces: [{ id: 'select', title: 'Выпадающий список', lang: 'html' }] }
      ],
      rankedPieces: [
        { id: 'ul', title: 'Список', lang: 'html', targetKey: '<ul>', position: 1 },
        { id: 'select', title: 'Выпадающий список', lang: 'html', targetKey: '<select>', position: 2 }
      ]
    },
    library: { hits: [] },
    variants: { roots: [] }
  });
  assert.ok(list.targets.some(target => target.targetKey === '<ul>'));
  assert.ok(!list.targets.some(target => target.targetKey === '<select>'));
});


test('область задачи распознаёт веб-сборку и не путает её с задачей по массивам', () => {
  assert.equal(inferTaskScope('Добавить кнопку, которая показывает сообщение при нажатии'), 'web');
  assert.equal(inferTaskScope('Свернуть массив в одно значение'), '');
  assert.equal(inferTaskScope('Python: получить элемент списка'), '');
});


test('общий JavaScript/TypeScript API не дублируется между языками без явного выбора', () => {
  const input = language => ({
    query: 'кнопка по нажатию показывает сообщение',
    language,
    directed: {
      hits: [{
        targetKey: 'addEventListener',
        score: 60,
        phrases: [{ phrase: 'подписаться на клик', language: 'ts' }],
        pieces: [
          { id: 'ts-handler', title: 'Обработчик TS', lang: 'ts' },
          { id: 'js-handler', title: 'Обработчик JS', lang: 'js' }
        ]
      }],
      rankedPieces: []
    },
    library: { hits: [] },
    variants: { roots: [
      { term: 'addEventListener', lang: 'ts', children: [] },
      { term: 'addEventListener', lang: 'js', children: [] }
    ] }
  });

  const general = combineTaskSearch(input(''));
  const generalRoots = general.roots.filter(root => root.term === 'addEventListener');
  assert.deepEqual(generalRoots.map(root => root.lang), ['js']);
  assert.equal(general.targets[0].rootLang, 'js');
  assert.deepEqual(generalRoots[0].children.map(child => child.piece), ['ts-handler', 'js-handler']);

  const typescript = combineTaskSearch(input('ts'));
  const tsRoots = typescript.roots.filter(root => root.term === 'addEventListener');
  assert.deepEqual(tsRoots.map(root => root.lang), ['ts']);
  assert.equal(typescript.targets[0].rootLang, 'ts');

  const tsOnly = combineTaskSearch({
    ...input(''),
    directed: { hits: [{
      targetKey: 'addEventListener',
      score: 60,
      phrases: [{ phrase: 'подписаться на клик', language: 'ts' }],
      pieces: [{ id: 'ts-only', title: 'Обработчик TS', lang: 'ts' }]
    }], rankedPieces: [] },
    variants: { roots: [{ term: 'addEventListener', lang: 'ts', children: [] }] }
  });
  assert.equal(tsOnly.roots.find(root => root.term === 'addEventListener')?.lang, 'ts');
});
