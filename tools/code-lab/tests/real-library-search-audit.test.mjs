// Полный HTTP-аудит теневого поиска на реальной библиотеке checkout.
// Запуск из корня репозитория: node tools/code-lab/tests/real-library-search-audit.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SERVER = path.join(ROOT, 'tools', 'code-lab-server.mjs');
const TESTSET = path.join(ROOT, 'tools', 'code-lab', 'SYNONYM-QUERY-TESTSET.md');
const OUT = path.join(ROOT, 'query-phrase-audit.json');
const port = 21000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const srv = spawn(process.execPath, [SERVER, String(port)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
srv.stdout.on('data', d => log += d);
srv.stderr.on('data', d => log += d);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const get = async url => {
  const response = await fetch(base + url);
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  return body;
};
const tokenText = token => token?.v != null ? String(token.v) : token?.k === 'sp' ? ' ' : '';
const templateText = template => (template?.lines || []).map(line => line.map(tokenText).join('')).join('\n');

async function main() {
  for (let i = 0; i < 180 && !log.includes('Лаборатория кода'); i++) await sleep(100);
  assert.ok(log.includes('Лаборатория кода'), 'HTTP-сервер не запустился:\n' + log.slice(-5000));

  const markdown = await fs.readFile(TESTSET, 'utf8');
  const queries = [...new Set(markdown.split(/\r?\n/)
    .filter(line => /^\|/.test(line))
    .map(line => line.split('|')[1]?.trim().replace(/`/g, ''))
    .filter(value => value && value !== 'Запрос' && !/^[-: ]+$/.test(value)))];
  assert.ok(queries.length >= 50, `Контрольный набор неожиданно мал: ${queries.length}`);

  const templateCache = new Map();
  const readTemplate = async id => {
    if (!templateCache.has(id)) {
      const value = await get('/api/template?id=' + encodeURIComponent(id));
      templateCache.set(id, {
        id: value.id, title: value.title, lang: value.lang, group: value.group,
        desc: value.desc, code: templateText(value)
      });
    }
    return templateCache.get(id);
  };

  const expectedCuratedTargets = {
    'отступ внутри элемента': ['padding'],
    'отступ снаружи элемента': ['margin'],
    'обводка вокруг элемента': ['border', 'outline'],
    'толщина шрифта': ['font-weight'],
    'межбуквенный интервал': ['letter-spacing'],
    'выровнять текст по центру': ['text-align'],
    'выровнять элементы по центру': ['align-items', 'justify-content'],
    'расположить элемент поверх другого': ['z-index'],
    'обтекание изображения текстом': ['float'],
    'спрятать элемент, сохранив место': ['visibility'],
    'скрыть элемент из потока': ['display'],
    'плавно изменить свойство': ['transition'],
    'медиазапрос для телефона': ['@media'],
    'объявить переменную': ['const', 'let', 'var'],
    'объявить константу': ['const'],
    'функция с именем': ['function', 'def'],
    'пройти по массиву': ['for', 'foreach'],
    'условие иначе': ['else'],
    'список Python': ['list'],
    'словарь Python': ['dict'],
    'разбить строку по разделителю': ['split'],
    'соединить элементы массива в строку': ['join'],
    'округлить до двух знаков': ['tofixed', 'round(x, n)'],
    'асинхронно дождаться результата': ['await'],
    'разобрать JSON': ['parse', 'json.loads(s)'],
    'сериализовать в JSON': ['stringify', 'json.dumps(obj)'],
    'подписаться на клик': ['addeventlistener'],
    'записать файл': ['write'],
    'подменить функцию в тесте': ['patch'],
    'подготовка перед тестом': ['def setup(self)'],
    'очистка после теста': ['def teardown(self)'],
    'корреляция двух рядов': ['np.corrcoef']
  };
  const results = [];
  for (const query of queries) {
    const comparison = await get('/api/search/shadow?q=' + encodeURIComponent(query) + '&limit=100');
    const legacy = comparison.legacy || { hits: [] };
    const shadow = comparison.shadow || { hits: [] };
    const expectedTargets = expectedCuratedTargets[query];
    if (expectedTargets) {
      const foundTargets = new Set((shadow.hits || []).map(hit => hit.targetKey));
      for (const target of expectedTargets) {
        assert.ok(foundTargets.has(target), `Курируемая фраза «${query}» не нашла цель «${target}» через HTTP`);
      }
    }
    const legacyHits = (legacy.hits || []).slice(0, 10).map((hit, index) => ({
      position: index + 1, id: hit.id, title: hit.title || hit.name || '',
      score: hit.score ?? hit.match?.score ?? null, why: hit.why || []
    }));
    const legacyPositions = new Map(legacyHits.map(hit => [hit.id, hit.position]));
    const shadowHits = [];
    for (const [index, hit] of shadow.hits.slice(0, 20).entries()) {
      const pieces = [];
      for (const [pieceIndex, piece] of (hit.pieces || []).slice(0, 3).entries()) {
        try {
          const full = await readTemplate(piece.id);
          pieces.push({ ...full, shadowTargetPosition: index + 1, piecePositionWithinTarget: pieceIndex + 1, legacyPosition: legacyPositions.get(piece.id) ?? null });
        } catch (error) {
          pieces.push({ id: piece.id, title: piece.title, fetchError: String(error) });
        }
      }
      shadowHits.push({
        position: index + 1, targetKey: hit.targetKey, score: hit.score,
        phrases: hit.phrases, sections: hit.sections, pieces
      });
    }
    const shadowRankedTop10 = await Promise.all((shadow.rankedPieces || []).slice(0, 10).map(async hit => {
      try { return { ...hit, fragment: await readTemplate(hit.id), legacyPosition: legacyPositions.get(hit.id) ?? null }; }
      catch (error) { return { ...hit, fetchError: String(error), legacyPosition: legacyPositions.get(hit.id) ?? null }; }
    }));
    const shadowRankedIds = new Set(shadowRankedTop10.map(hit => hit.id));
    results.push({
      query, legacyTotal: legacy.total ?? legacyHits.length,
      legacyTop10: await Promise.all(legacyHits.map(async hit => {
        try { return { ...hit, fragment: await readTemplate(hit.id) }; }
        catch (error) { return { ...hit, fetchError: String(error) }; }
      })),
      shadowTotal: shadow.total ?? shadow.hits.length,
      shadowAmbiguous: shadow.ambiguous,
      shadowTop20: shadowHits,
      shadowRankedTop10,
      legacyOnlyTop10: legacyHits.filter(hit => !shadowRankedIds.has(hit.id)),
      shadowOnlyTop10: shadowRankedTop10.filter(hit => hit.legacyPosition == null),
      productionSearchChanged: comparison.productionSearchChanged
    });
  }

  const jsFunctionSearch = await get('/api/search/shadow?q=' + encodeURIComponent('функция с именем') + '&lang=js&limit=100');
  const jsFunctionHits = jsFunctionSearch.shadow?.hits || [];
  assert.ok(jsFunctionHits.some(hit => hit.targetKey === 'function'), 'JS-контекст должен оставить function');
  assert.ok(!jsFunctionHits.some(hit => hit.targetKey === 'def'), 'JS-контекст не должен подмешивать Python def');
  assert.ok(jsFunctionHits.flatMap(hit => hit.pieces || []).every(piece => piece.lang === 'js'), 'JS-контекст не должен возвращать фрагменты другого языка');

  const pythonFunctionSearch = await get('/api/search/shadow?q=' + encodeURIComponent('функция с именем') + '&lang=python&limit=100');
  const pythonFunctionHits = pythonFunctionSearch.shadow?.hits || [];
  assert.ok(pythonFunctionHits.some(hit => hit.targetKey === 'def'), 'Python-контекст должен оставить def');
  assert.ok(!pythonFunctionHits.some(hit => hit.targetKey === 'function'), 'Python-контекст не должен подмешивать JS function');
  assert.ok(pythonFunctionHits.flatMap(hit => hit.pieces || []).every(piece => piece.lang === 'python'), 'Python-контекст не должен возвращать фрагменты другого языка');

  const taskScenarios = [
    'Добавить кнопку, которая по нажатию показывает сообщение',
    'Сделать надпись ссылкой на другую страницу',
    'Сделать блок, который можно раскрыть и свернуть',
    'Подсветить текст заголовка в шапке при наведении курсора',
    'Получить данные из двух источников и вывести имя в шапку, список в основной блок, итог внизу',
    'Свернуть боковую панель, чтобы её можно было снова открыть'
  ];
  const taskResults = [];
  const taskResultMap = new Map();
  for (const query of taskScenarios) {
    const result = await get('/api/search/task?q=' + encodeURIComponent(query) + '&limit=30');
    assert.equal(result.mode, 'task', `неверный режим единого поиска для «${query}»`);
    assert.ok(Array.isArray(result.roots) && Array.isArray(result.pieces), `нет корней или фрагментов для «${query}»`);
    assert.ok(result.roots.length || result.pieces.length, `поиск не дал ни одной конструкции или фрагмента для «${query}»`);
    taskResultMap.set(query, result);
    taskResults.push({
      query,
      targets: result.targets.slice(0, 12).map(x => ({
        key: x.targetKey, score: x.score, pieceCount: x.pieceCount, rootLang: x.rootLang,
        phrases: (x.phrases || []).slice(0, 2).map(p => ({ phrase: p.phrase, match: p.match?.kind, score: p.match?.score }))
      })),
      roots: result.roots.slice(0, 12).map(x => ({ term: x.term || x.label, lang: x.lang, score: x.score, label: x.label })),
      pieces: result.pieces.slice(0, 8).map(x => ({
        title: x.title, lang: x.lang, score: x.score, sources: x.sources,
        matchedTargets: x.matchedTargets, contextBoost: x.contextBoost,
        why: (x.why || []).slice(0, 4)
      })),
      counts: result.counts
    });
  }
  const taskTerms = query => {
    const result = taskResultMap.get(query);
    return [
      ...(result?.targets || []).map(x => String(x.targetKey).toLowerCase()),
      ...(result?.roots || []).map(x => String(x.term || '').toLowerCase())
    ];
  };
  const buttonQuery = taskScenarios[0], linkQuery = taskScenarios[1], collapseQuery = taskScenarios[2];
  const hoverQuery = taskScenarios[3], dataQuery = taskScenarios[4], sidebarQuery = taskScenarios[5];
  const buttonTitles = taskResultMap.get(buttonQuery).pieces.map(piece => piece.title);
  assert.ok(!buttonTitles.some(title => /форма|formdata|submit|отправк формы/i.test(title)), 'простая кнопка не должна притягивать отправку формы');
  const linkTitles = taskResultMap.get(linkQuery).pieces.map(piece => piece.title);
  assert.ok(!linkTitles.some(title => /style\.css|stylesheet|google fonts|image map|карта областей изображения|ссылка при наведении|убрать подчёркивание|defaultprevented/i.test(title)), 'ссылка на страницу не должна смешиваться с подключением ресурсов и image map');
  const collapseTitles = taskResultMap.get(collapseQuery).pieces.map(piece => piece.title);
  assert.ok(!collapseTitles.some(title => /групп.*сообщен|сообщен.*групп|канонический путь|symbolic link/i.test(title)), 'сворачиваемый блок не должен смешиваться с группами сообщений и файловыми путями');

  const buttonTerms = taskTerms(buttonQuery);
  assert.ok(!buttonTerms.includes('form'), 'обычная кнопка не должна превращаться в форму');

  const linkTerms = taskTerms(linkQuery);
  assert.ok(linkTerms.includes('a') && !linkTerms.includes('link'), 'переход на страницу должен вести к <a>, а не к ресурсному тегу <link>');
  assert.ok(!linkTerms.includes('none') && !linkTerms.includes(':hover'), 'переход по ссылке не должен превращаться в CSS-состояние или значение оформления');

  const collapseTerms = taskTerms(collapseQuery);
  const hoverTerms = taskTerms(hoverQuery);
  assert.ok(taskResultMap.get(buttonQuery).roots.findIndex(x => /button/.test(String(x.term))) < 3, 'HTML-кнопка должна быть среди первых трёх корней');
  assert.ok(!buttonTerms.some(x => x === 'disabled' || x === 'event.target'), 'простая кнопка не должна подменяться состоянием disabled или event.target');
  assert.ok(!linkTerms.some(x => /innertext/.test(x)), 'обычная ссылка не должна притягивать чтение отображаемого текста');
  assert.ok(!collapseTerms.some(x => ['display', 'grid', 'height', 'position', 'width'].includes(x)), 'сворачивание блока не должно совпадать с общими CSS-свойствами по слову «блок»');
  assert.ok(!hoverTerms.some(x => x === 'textcontent'), 'подсветка при наведении не должна подменяться изменением текста');
  assert.ok(!taskResultMap.get(buttonQuery).pieces.some(x => /Service Worker|Web Worker/i.test(x.title)), 'не подмешивать worker-фрагменты к обычной кнопке');
  assert.ok(!taskResultMap.get(linkQuery).pieces.some(x => /символическ.*ссылк|удаление файла/i.test(x.title)), 'не подмешивать файловые ссылки к HTML-ссылке');
  assert.ok(!taskResultMap.get(collapseQuery).pieces.some(x => /Свёртка массива|свернуть в одно значение|gl\.useProgram|экранной клавиатур/i.test(x.title)), 'не подмешивать свёртку массива и посторонние UI-фрагменты к раскрываемому блоку');
  assert.ok(taskTerms(buttonQuery).some(x => /button/.test(x)), 'кнопка должна находиться в HTML');
  assert.ok(taskTerms(buttonQuery).some(x => /addeventlistener|click/.test(x)), 'для кнопки должен находиться обработчик события');
  assert.ok(taskTerms(buttonQuery).some(x => /alert|textcontent|innertext/.test(x)), 'должен находиться способ показать сообщение');
  assert.ok(!taskResultMap.get(buttonQuery).pieces.some(x => /геймпад|gamepad|keydown|keyup|клавиатур/.test(x.title)), 'не подмешивать игровые и клавиатурные кнопки');
  assert.ok(!taskResultMap.get(buttonQuery).pieces.some(x => /getEventListeners|DevTools|stopPropagation/.test(x.title)), 'не подмешивать диагностические и propagation-конструкции без запроса');
  assert.ok(taskTerms(linkQuery).some(x => x === 'a' || x === '<a>'), 'ссылка должна находиться как HTML-элемент a');
  assert.ok(taskTerms(linkQuery).some(x => x === 'href'), 'для ссылки должен находиться href');
  assert.ok(!taskTerms(linkQuery).some(x => /button/.test(x)), 'ссылка не должна подменяться кнопкой');
  assert.equal(taskResultMap.get(linkQuery).pieces[0]?.title, 'Ссылка на другую страницу', 'точный библиотечный фрагмент ссылки должен быть выше общих совпадений');
  assert.ok(!taskResultMap.get(linkQuery).pieces.some(x => /Web Worker|Service Worker|сериализуем|replaceChildren|insertAdjacentHTML/i.test(x.title)), 'не подмешивать worker и динамическую вставку к обычной ссылке');
  const details = taskResultMap.get(collapseQuery).roots.find(x => x.term === 'details');
  assert.ok(details, 'для раскрываемого блока должен находиться нативный details');
  assert.match(JSON.stringify(details.children), /summary/, 'внутри details должен показываться summary');
  assert.ok(taskTerms(hoverQuery).some(x => x === ':hover'), 'для наведения должен находиться :hover');
  assert.ok(taskTerms(hoverQuery).some(x => x === 'color'), 'для подсветки должен находиться цвет текста');
  assert.ok(taskTerms(hoverQuery).some(x => x === '<header>'), 'должна учитываться шапка страницы');
  assert.ok(!taskTerms(hoverQuery).some(x => /letter-spacing|line-height|sort|write/.test(x)), 'не подмешивать несвязанные свойства и команды');
  assert.ok(!taskTerms(dataQuery).some(term => term === 'get' || term === 'list'), 'слова «получить» и «список» не должны превращаться в HTML-метод GET и атрибут list');
  const dataTargets = taskResultMap.get(dataQuery).targets.map(x => x.targetKey);
  assert.ok(dataTargets.indexOf('fetch') >= 0 && dataTargets.indexOf('response.json()') > dataTargets.indexOf('fetch'), 'получение данных должно стоять выше разбора JSON-ответа: ' + dataTargets.join(', ') + '; counts=' + JSON.stringify(taskResultMap.get(dataQuery).counts));
  assert.ok(taskResultMap.get(dataQuery).counts.directedPieces > 0, 'по найденным целям должны подбираться связанные фрагменты');
  assert.ok(taskResultMap.get(dataQuery).pieces.some(piece => (piece.matchedTargets || []).includes('fetch')), 'фрагмент запроса должен быть связан с целью fetch');
  const dataPieceTitles = taskResultMap.get(dataQuery).pieces.map(piece => piece.title);
  assert.ok(dataPieceTitles.some(title => /fetch \+ await/i.test(title)), 'основной пример должен показывать получение данных через fetch');
  assert.ok(!dataPieceTitles.some(title => /fetch post|учётные данные|учетные данные|imagebitmap|insertadjacenthtml|element\.attributes|первый успешный промис|msw|подменить ответ сервера/i.test(title)), 'не подмешивать POST, авторизацию, декодирование изображения, HTML-вставку и атрибуты к задаче чтения данных');


  assert.ok(!dataTargets.some(x => ['display', 'grid', 'append'].includes(x)), 'вывод данных в блоки не должен притягивать общие CSS-свойства и append по слову «блок»');
  assert.ok(taskTerms(dataQuery).some(x => /fetch/.test(x)), 'должен находиться запрос данных');
  assert.ok(taskTerms(dataQuery).some(x => /promise.all/.test(x)), 'для нескольких источников должен находиться Promise.all');
  assert.ok(taskTerms(dataQuery).some(x => x.includes('response.json')), 'должен находиться разбор JSON-ответа');
  assert.ok(taskTerms(dataQuery).some(x => /queryselector/.test(x)), 'должен находиться выбор элементов страницы');
  assert.ok(taskTerms(dataQuery).some(x => /textcontent|innertext/.test(x)), 'должен находиться вывод текста в элемент');
  assert.ok(taskTerms(dataQuery).some(x => x === '<header>') && taskTerms(dataQuery).some(x => x === '<footer>'), 'должны находиться разные места вывода');
  assert.ok(!taskTerms(dataQuery).some(x => /math.floor|event.target/.test(x)), 'не подмешивать незаказанные операции');
  assert.ok(!taskResultMap.get(dataQuery).pieces.some(x => /узла|IndexedDB|Ковариация|Корреляция/.test(x.title)), 'не подмешивать метаданные DOM-узлов и статистические фрагменты');
  assert.ok(!taskResultMap.get(dataQuery).pieces.some(x => /Service Worker|Web Worker|push-сообщение/i.test(x.title)), 'не подмешивать фоновые worker-сообщения к обычной загрузке данных');
  assert.ok(taskTerms(sidebarQuery).some(x => x === '<aside>'), 'боковая панель должна находиться как aside');
  assert.ok(taskResultMap.get(sidebarQuery).roots.some(x => x.term === '<aside>'), 'aside должен быть виден в дереве вариантов, а не только в скрытых метаданных');
  assert.ok(!taskTerms(sidebarQuery).some(x => /reduce/.test(x)), 'сворачивание панели не должно превращаться в свёртку массива');

  console.log('TASK SEARCH REAL SCENARIOS:', JSON.stringify(taskResults));

  const report = {
    generatedAt: new Date().toISOString(),
    branch: 'audit/fixes-2026-11-06',
    commit: process.env.GITHUB_SHA || null,
    libraryMode: 'real repository checkout; no synthetic fixture',
    shadowRanking: 'fragment-level; exact and token-overlap phrase matches with Russian stemming, plus title/description/tags/aliases relevance; deterministic heuristic, not semantic model ranking',
    comparisonNote: 'shadow and legacy now expose fragment positions; their scoring systems differ, so compare rank movement and content relevance rather than raw score values',
    queryCount: queries.length,
    phraseCount: (await get('/api/search/shadow?q=' + encodeURIComponent(queries[0]) + '&limit=1')).shadowPhraseCount,
    templateCount: templateCache.size,
    taskResults,
    results
  };
  await fs.writeFile(OUT, JSON.stringify(report, null, 2) + '\n');
  const httpErrors = results.filter(result => result.productionSearchChanged !== false);
  assert.equal(httpErrors.length, 0, 'Один или несколько ответов не подтвердили неизменность production search');
  console.log(`REAL LIBRARY HTTP AUDIT: ${queries.length} queries; ${templateCache.size} full fragments; report: ${OUT}`);
  console.log(`Queries with shadow hits: ${results.filter(result => result.shadowTotal > 0).length}`);
  console.log(`Queries with ambiguous targets: ${results.filter(result => result.shadowAmbiguous).length}`);
}

try {
  await main();
} finally {
  srv.kill('SIGTERM');
  await sleep(300);
  if (srv.exitCode == null) srv.kill('SIGKILL');
}
