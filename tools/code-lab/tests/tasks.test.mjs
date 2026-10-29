// Задачи (деревья решений): текстовый формат, хранилище с привязкой ссылок, «что дальше», проверка скобок.
// Запуск: node --test tools/code-lab/tests/tasks.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createTaskStore, suggestNext, createTaskRanker, TaskFormat } from '../lib/tasks.mjs';

const require = createRequire(import.meta.url);
const CodeCheck = require('../public/code-check.js');

const SAMPLE = `=== Реагировать на клик | js | Интерфейс / События
> Найти кнопку и сделать что-то по клику.
~ клик, нажатие
? Как найти кнопку?
| подсказка
  - по классу -> кусок: Найти элемент
    | когда у кнопки есть класс
  - по id -> код
    \`\`\`js
    const btn = document.getElementById('save');
    if (btn) {
      btn.disabled = false;
    }
    \`\`\`
  - иначе
    ? Вложенный вопрос
      - a -> задача: Показать блок
      - b -> пропустить
! Повесить обработчик -> кусок: id:click-1
  | зачем`;

test('формат: разбор вложенности, заметок, кода и шагов без выбора', () => {
  const { tasks, warnings } = TaskFormat.parse(SAMPLE);
  assert.deepEqual(warnings, []);
  assert.equal(tasks.length, 1);
  const t = tasks[0];
  assert.equal(t.lang, 'js'); assert.equal(t.group, 'Интерфейс / События');
  assert.deepEqual(t.aliases, ['клик', 'нажатие']);
  assert.equal(t.steps.length, 2);
  const [s1, s2] = t.steps;
  assert.equal(s1.hint, 'подсказка');
  assert.equal(s1.options[0].note, 'когда у кнопки есть класс');
  assert.equal(s1.options[1].kind, 'code');
  assert.equal(s1.options[1].code, "const btn = document.getElementById('save');\nif (btn) {\n  btn.disabled = false;\n}");
  assert.equal(s1.options[2].steps[0].options[0].kind, 'task');
  assert.equal(s1.options[2].steps[0].options[1].kind, 'skip');
  assert.ok(s2.auto); assert.equal(s2.options[0].ref, 'id:click-1'); assert.equal(s2.options[0].note, 'зачем');
});

test('формат: текст → дерево → текст → то же дерево', () => {
  const a = TaskFormat.parse(SAMPLE).tasks[0];
  const b = TaskFormat.parse(TaskFormat.serialize(a)).tasks[0];
  assert.deepEqual(b, a);
});

test('формат: терпит варианты без отступа и несколько задач подряд', () => {
  const { tasks } = TaskFormat.parse('=== A | js |\n? Q\n- x -> X\n- y -> пропустить\n=== B | python |\n? Q2\n  - z -> код\n    ```python\n    print(1)\n    ```');
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].steps[0].options.length, 2);
  assert.equal(tasks[1].steps[0].options[0].code, 'print(1)');
});

test('хранилище: ссылки на куски и задачи привязываются, «код» остаётся в задаче, повторный импорт не плодит двойники', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tasks-'));
  const rows = [{ id: 'el-1', title: 'Найти элемент', lang: 'js', comp: { provides: ['el'], requires: [] } },
                { id: 'click-1', title: 'Клик', lang: 'js', comp: { provides: [], requires: ['btn'] } }];
  let n = 0;
  const store = createTaskStore({ root, rows: async () => rows, slug: s => s.replace(/\s+/g, '-') + '-' + (++n) });
  const text = SAMPLE + '\n=== Показать блок | js | Интерфейс\n? Как?\n  - классом -> кусок: нет такого';
  const dry = await store.importText(text, { dry: true });
  assert.equal(dry.tasks.length, 2);
  const r = await store.importText(text);
  assert.equal(rows.length, 2, 'библиотека не пополняется кодом вариантов');
  const list = await store.list(); assert.equal(list.length, 2);
  const main = await store.get(list.find(t => t.title === 'Реагировать на клик').id);
  const o = main.steps[0].options;
  assert.equal(o[0].id, 'el-1'); assert.equal(o[1].kind, 'code'); assert.ok(o[1].code.includes('getElementById'));
  assert.equal(o[2].steps[0].options[0].id, list.find(t => t.title === 'Показать блок').id, 'ссылка на задачу из той же пачки');
  assert.equal(main.steps[1].options[0].id, 'click-1', 'ссылка id:…');
  assert.deepEqual(r.tasks.find(t => t.title === 'Показать блок').report.unresolved.map(u => u.ref), ['нет такого']);
  await store.importText(text);
  assert.equal((await store.list()).length, 2, 'одноимённые задачи обновляются');
  const txt = await store.toText(main);
  assert.ok(txt.includes('-> кусок: Найти элемент')); assert.ok(txt.includes('-> задача: Показать блок'));
  assert.deepEqual((await store.usedBy('el-1')).map(t => t.title), ['Реагировать на клик']);
  await fs.rm(root, { recursive: true, force: true });
});

test('что дальше: имя без источника → куски и задачи, которые его дают; HTML закрывает #id', () => {
  const contract = (code, lang) => lang === 'html' ? { provides: ['#box'], requires: [] } : { provides: ['run'], requires: ['btn', '#box', 'i'] };
  const rows = [{ id: 'p1', title: 'Кнопка', lang: 'js', nlines: 2, comp: { provides: ['btn'], requires: [] } }];
  const tasks = [{ id: 't1', title: 'Клик', steps: [{ q: '', options: [{ kind: 'piece', id: 'p1', steps: [] }] }] }];
  const r = suggestNext({ files: [{ name: 'a.js', lang: 'js', code: '' }, { name: 'i.html', lang: 'html', code: '' }], contract, contractLangs: new Set(['js', 'html']), rows, tasks });
  const by = Object.fromEntries(r.unmet.map(u => [u.name, u]));
  assert.ok(!by['#box'], '#box даёт HTML');
  assert.deepEqual(by.btn.pieces.map(p => p.id), ['p1']);
  assert.deepEqual(by.btn.tasks.map(t => t.id), ['t1']);
  assert.ok(by.i.generic);
});

test('скобки и кавычки: находит оборванное, не путается в строках, комментариях и регулярках', () => {
  const ok = CodeCheck.scanBrackets('const a = "(" + `)${x}` ; // ) \n/* { */ const re = /[(]/g; f(a[0], { b: 1 });', 'js');
  assert.deepEqual(ok, []);
  const bad = CodeCheck.scanBrackets('function f() {\n  if (x {\n    g(1);\n  }\n', 'js');
  assert.ok(bad.length >= 1);
  assert.ok(bad.some(x => x.msg.includes('не закрыта') || x.msg.includes('не той')));
  assert.equal(CodeCheck.scanBrackets("print('a\n", 'python').length, 2, 'кавычка и скобка');
  assert.deepEqual(CodeCheck.scanBrackets("# it's fine (\nx = [1, 2]\n", 'python'), []);
  assert.deepEqual(CodeCheck.scanBrackets('<p>it\'s (ok</p>', 'html'), []);
  assert.equal(CodeCheck.scanBrackets('a { color: red;', 'css').length, 1);
});

test('позиции имени: обычное имя, селектор и таблица', () => {
  const code = "btn.onclick = go; const x = q('#save'); obj.btn = 1; SELECT * FROM users";
  assert.equal(CodeCheck.namePositions(code, 'btn').length, 1, 'после точки не считается');
  assert.equal(CodeCheck.namePositions(code, '#save').length, 1);
  assert.equal(CodeCheck.namePositions(code, 'tbl:users').length, 1);
  assert.ok(CodeCheck.needText('#save').includes('id="save"'));
});

test('кандидаты: только у ненайденных ссылок, найденные привязываются молча', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tasks-'));
  const rows = [{ id: 'q1', title: 'querySelector — найти элемент', lang: 'js' }];
  let asked = 0;
  const store = createTaskStore({ root, rows: async () => rows, slug: s => 'id-' + s.length,
    similarPieces: async () => { asked++; return rows; } });
  const r = await store.importText('=== T | js |\n? Q\n  - a -> кусок: querySelector — найти элемент\n  - b -> кусок: найти элемент по селектору\n  - c -> задача: Показать блок', { dry: true });
  const un = r.tasks[0].report.unresolved;
  assert.equal(asked, 1, 'поиск похожих только для одной ненайденной ссылки на кусок');
  assert.deepEqual(un.map(u => u.ref), ['найти элемент по селектору', 'Показать блок']);
  assert.deepEqual(un[0].candidates.map(c => c.id), ['q1']);
  assert.deepEqual(un[1].candidates, []);
  await fs.rm(root, { recursive: true, force: true });
});

test('пригодится: сигнал от кода обязателен, слова у курсора только усиливают, сделанное не предлагается', async () => {
  const entries = async () => [
    { id: 'btn', code: "const btn = document.querySelector('.save');" },
    { id: 'clk', code: "btn.addEventListener('click', onSave);" },
    { id: 'frm', code: "const form = document.querySelector('form'); form.addEventListener('submit', send);" }];
  const rows = [{ id: 'btn', comp: { provides: ['btn'] } }, { id: 'clk', comp: { provides: [] } }, { id: 'frm', comp: { provides: ['form'] } }];
  const t = (id, title, ids, aliases) => ({ id, title, lang: 'js', aliases: aliases || [], savedAt: 1, steps: ids.map(x => ({ q: '', options: [{ kind: 'piece', id: x, steps: [] }] })) });
  const tasks = [t('click', 'Реагировать на клик', ['btn', 'clk']), t('form', 'Отправить форму', ['frm'], ['отправка'])];
  const ranker = createTaskRanker({ entries });
  // коду не хватает btn → «клик» всплывает
  let hits = await ranker.rank({ tasks, rows, next: { provided: [], unmet: [{ name: 'btn' }] }, lang: 'js', window: "btn.addEventListener('click', go)", cursor: '' });
  assert.deepEqual(hits.map(h => h.id), ['click']);
  assert.ok(hits[0].why[0].includes('btn'));
  // только слова у курсора («отправка формы») без сигнала от кода — ничего
  hits = await ranker.rank({ tasks, rows, next: { provided: [], unmet: [] }, lang: 'js', window: 'let x = 1;', cursor: '// отправка формы' });
  assert.deepEqual(hits, []);
  // всё, что даёт задача, уже есть в коде — не предлагаем
  hits = await ranker.rank({ tasks, rows, next: { provided: ['form'], unmet: [] }, lang: 'js', window: "const form = document.querySelector('form'); form.addEventListener('submit', send);", cursor: '' });
  assert.ok(!hits.find(h => h.id === 'form'));
});

test('разделы: самое длинное совпадение, «/ *» оставляет подраздел, без правила — как было', async () => {
  const { parseRules, mapGroup, placeInTree, treeFromText } = await import('../lib/sections.mjs');
  const { rules, bad } = parseRules(['Данные => Данные / *', 'Данные / Строки и текст => Основы языка / Строки и текст', 'CSS: основы => Вёрстка и стили / Основы CSS', 'плохая строка']);
  assert.deepEqual(bad, ['плохая строка']);
  assert.equal(mapGroup('Данные / Сортировка', rules).to, 'Данные / Сортировка');
  assert.equal(mapGroup('Данные/Строки и текст', rules).to, 'Основы языка / Строки и текст');
  assert.equal(mapGroup('CSS: основы / Селекторы', rules).to, 'Вёрстка и стили / Основы CSS');
  assert.equal(mapGroup('Неизвестное / Что-то', rules).rule, null);
  const tree = treeFromText('Данные: Сортировка; Массивы\nОсновы языка: Строки и текст');
  assert.deepEqual(placeInTree('Данные / Сортировка', tree), { top: true, sub: true });
  assert.deepEqual(placeInTree('Данные / Прочее', tree), { top: true, sub: false });
  assert.deepEqual(placeInTree('Сеть', tree), { top: false, sub: true });
});

test('подписи к «даёт/нужно»: из кода и словаря, служебное приглушено, общие слова словарём не толкуются', async () => {
  const { explainNames } = await import('../lib/contract-labels.mjs');
  const dict = { words: {}, langs: { js: { ctx: 'объект контекста рисования Canvas', 'const ctx = canvas.getcontext("2d")': 'получить двумерный контекст рисования', key: 'функция сортировки', fetch: 'выполнить сетевой запрос', error: 'ошибка, общая ошибка, исключение, сбой' } } };
  const code = "const canvas = document.querySelector('#scene');\nconst ctx = canvas.getContext('2d');\nfunction draw(x, y) { ctx.fill(); }\nconst http = require('http');\nconst a = [1, 2];\nconst key = 'k';\nconst r = await fetch(url);";
  const L = explainNames(code, 'js', ['canvas', 'ctx', 'draw', 'http', 'a', 'key', 'url', 'r', '#scene', 'Error'], dict);
  assert.match(L.canvas.text, /элемент страницы #scene/);
  assert.match(L.ctx.text, /контекст/);
  assert.equal(L.draw.kind, 'функция'); assert.match(L.draw.text, /\(x, y\)/);
  assert.match(L.http.text, /модуль http/);
  assert.ok(L.a.service, 'однобуквенное — служебное');
  assert.ok(!/сортировк/.test(L.key.text), 'общее слово не толкуется словарём');
  assert.equal(L.url.kind, 'снаружи');
  assert.match(L['#scene'].text, /id="scene"/);
  assert.ok(!/общая ошибка/.test(L.Error.text), 'список синонимов — не подпись');
});

test('«кусок:» с названием задачи становится ссылкой на задачу; одновременные сохранения не плодят копии', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tasks-'));
  let n = 0;
  const store = createTaskStore({ root, rows: async () => [], slug: s => 'id' + (++n), similarPieces: async () => [] });
  await store.importText('=== Отправить форму | js |\n? Q\n  - a -> пропустить');
  const r = await store.importText('=== Проверить поле | js |\n? Q\n  - ок -> кусок: Отправить форму', { dry: true });
  assert.equal(r.tasks[0].report.unresolved.length, 0);
  assert.equal(r.tasks[0].report.converted, 1);
  assert.equal(r.tasks[0].task.steps[0].options[0].kind, 'task');
  const text = '=== Двойной клик | js |\n? Q\n  - a -> пропустить';
  await Promise.all([store.importText(text), store.importText(text), store.importText(text)]);
  await store.save({ title: 'Двойной клик', steps: [] });
  assert.equal((await store.list()).filter(t => t.title === 'Двойной клик').length, 1);
  await store.importText('=== Повтор | js |\n? Q\n  - a -> пропустить\n=== Повтор | js |\n? Q2\n  - b -> пропустить');
  assert.equal((await store.list()).filter(t => t.title === 'Повтор').length, 1, 'одноимённые внутри пачки — одна задача');
  await fs.rm(root, { recursive: true, force: true });
});

test('дерево вариантов: смысл → термины по синонимам → разновидности по имени; регистр — из библиотеки', async () => {
  const { buildVariants, caseMapFrom } = await import('../lib/variant-tree.mjs');
  const dict = { langs: {
    css: { margin: '1.5em: внешний', 'margin-inline': 'auto: по строке', 'margin-inline-start': '1rem: в начале строки', 'margin-top': '1rem: сверху', padding: '1rem: внутренний', 'body { margin': 'обрывок' },
    js: { 'document.queryselector': 'найти первый элемент', 'document.queryselector(selector)': 'вызов' } } };
  const synonyms = { margin: ['внешний отступ'], padding: ['внутренний отступ'], 'document.queryselector': ['найти элемент по селектору'] };
  const r = buildVariants({ q: 'отступ', lang: 'css', dict, synonyms });
  assert.deepEqual(r.roots.map(n => n.term), ['margin', 'padding']);
  const m = r.roots[0];
  assert.equal(m.code, 'margin: 1.5em;'); assert.equal(m.label, 'внешний отступ');
  const mi = m.children.find(c => c.term === 'margin-inline');
  assert.ok(mi && mi.children.some(c => c.term === 'margin-inline-start'), 'margin-inline-start — внутри margin-inline');
  assert.ok(!m.children.some(c => c.term === 'body { margin'), 'обрывки не показываются');
  const cm = caseMapFrom(['document.querySelector(".a"); document.querySelector("b")']);
  const j = buildVariants({ q: 'найти элемент', lang: 'js', dict, synonyms, caseMap: cm });
  assert.equal(j.roots[0].code, 'document.querySelector(selector)');
});

test('свои имена: что внутри, где объявлено, опечатки имени и метода', async () => {
  const { analyzeNames } = await import('../lib/code-names.mjs');
  const { explainNames } = await import('../lib/contract-labels.mjs');
  const dict = { words: { 'el.addEventListener': 'подписаться на событие', 'classList.toggle': 'переключить класс' }, langs: { js: {} } };
  const code = "const btn = document.querySelector('.save');\nconst напитки = ['чай', 'кофе'];\nbtnn.addEventListner('click', f);\nconsole.log(напиткии.length, 'btnn');";
  const r = analyzeNames(code, 'js', { dict, globals: new Set(['document', 'console', 'f']), explain: (c, l, n) => explainNames(c, l, n, dict) });
  assert.equal(r.names.btn.line, 0);
  assert.match(r.names['напитки'].text, /список.*чай.*\(2\)/);
  const by = Object.fromEntries(r.typos.map(t => [t.name, t]));
  assert.equal(by.btnn.maybe, 'btn'); assert.equal(by.btnn.declLine, 0); assert.equal(by.btnn.kind, 'имя');
  assert.equal(by['напиткии'].maybe, 'напитки');
  assert.equal(by.addEventListner.kind, 'метод'); assert.equal(by.addEventListner.maybe.toLowerCase(), 'addeventlistener');
  // в строках и у объявленных имён опечаток нет
  assert.equal(r.typos.filter(t => t.name === 'btnn').length, 1);
  assert.ok(!by.btn && !by.length);
});

test('связи слов: ядро, начало пояснения, правки, вложенность', () => {
  const L = require('../public/code-links.js');
  assert.equal(L.relationOf('btn.addEventListener', 'js', {}).rel, 'когда');
  assert.equal(L.relationOf('elif', 'python', {}).rel, 'если');
  assert.equal(L.relationOf('hover', 'css', {}).rel, 'когда');           // :hover — по слову без двоеточия
  assert.equal(L.relationOf('fetch', 'js', {}, 'fetch — получить ответ сервера').rel, 'откуда');
  assert.equal(L.relationOf('console.log', 'js', {}, 'вывести данные в консоль').rel, 'куда');
  assert.equal(L.relationOf('length', 'js', {}, 'длина массива'), null);
  // «задать отступ» в CSS — оформление, а не поток данных
  assert.equal(L.relationOf('margin', 'css', {}, 'задать внешний отступ'), null);
  // правка пользователя важнее ядра; пустая — «связи нет»
  const dict = { relations: { js: { map: 'куда', then: '' } } };
  assert.equal(L.relationOf('arr.map', 'js', dict).rel, 'куда');
  assert.equal(L.relationOf('then', 'js', dict).rel, '');
  assert.deepEqual(L.depths("a(() => {\n  if (x) {\n    y();\n  }\n});", 'js'), [0, 2, 3, 2, 0]);
  assert.deepEqual(L.depths('for a in b:\n    if a:\n        f()\nprint(1)', 'python'), [0, 1, 2, 0]);
});

test('варианты: куски из библиотеки по смыслу названия, язык файла первым', async () => {
  const { buildVariants } = await import('../lib/variant-tree.mjs');
  const rows = [{ id: 'a', lang: 'js', title: 'Адаптивный размер холста' }, { id: 'b', lang: 'css', title: 'Адаптивная сетка карточек' }, { id: 'c', lang: 'css', title: 'Тень у кнопки' }];
  const r = buildVariants({ q: 'адаптивный', lang: 'css', dict: { langs: { css: {} } }, rows, synonyms: {} });
  const g = r.roots.find(n => n.group);
  assert.ok(g, 'есть ветка кусков');
  assert.deepEqual(g.children.map(c => c.piece), ['b', 'a']);
  assert.equal(buildVariants({ q: 'адаптивный', lang: 'css', dict: { langs: {} }, rows: [], synonyms: {} }).roots.length, 0);
});

test('раскладка: смесь букв, русская и английская раскладка, строки не трогаем', () => {
  const L = require('../public/layout-check.js');
  const known = new Set(['const', 'document', 'queryselector', 'console', 'log', 'напитки', 'display', 'color', 'class', 'div']);
  const js = "сщтые btn = dщcument.querySelector('.go'); // комментарий\nсonsole.log(yfgbnrb, 'текст');\nlet тест = 1;";
  const r = L.check(js, 'js', known).map(x => x.word + '>' + x.fix);
  assert.deepEqual(r, ['сщтые>const', 'dщcument>document', 'сonsole>console', 'yfgbnrb>напитки']);
  assert.deepEqual(L.check('.a { вшыздфн: flex; сolor: red; }', 'css', known).map(x => x.fix), ['display', 'color']);
  // в HTML русский текст между тегами — норма
  assert.deepEqual(L.check('<вшм сlass="Привет">текст</div>', 'html', known).map(x => x.fix), ['div', 'class']);
  assert.equal(L.ruToEn('сщтые'), 'const');
});

test('правила структуры: разбор, HTML-вложенность, CSS «требует», JS/Python «внутри/после», шаблон', () => {
  const S = require('../public/structure-rules.js');
  const all = require('../public/dict/structure.json');
  for(const l of Object.keys(all)) assert.equal(S.parse(all[l].join('\n')).bad.length, 0, 'правила ' + l + ' разбираются');
  const p = S.parse('li: внутри ul, ol — пояснение\nкривая строка\nx: странно что-то');
  assert.equal(p.rules.length, 2); assert.equal(p.rules[0].note, 'пояснение'); assert.equal(p.bad.length, 1);
  assert.equal(p.rules[1].verb, 'заметка'); assert.ok(p.rules[1].guessed);   // «x: странно что-то» — не правило, а заметка
  const R = l => S.parse(all[l].join('\n')).rules;
  const msgs = (c, l) => S.check(c, l, R(l)).map(x => x.msg.split(' — ')[0]);
  assert.deepEqual(msgs('<ul><li>a</li></ul>\n<li>b</li>\n<p><div>x</div></p>', 'html'), ['<li> должен быть внутри <ul>, <ol>, <menu>', '<p> не может содержать <div>']);
  assert.deepEqual(msgs('.a { gap: 1px }\n.b { display: grid; gap: 1px }', 'css').length, 1);
  assert.deepEqual(msgs('async function h(){ await g(); }\nif (a) {\n} else {\n}\nfoo();\nelse {\n}\nawait z();', 'js'), ['else идёт только после if', 'await работает только внутри async']);
  assert.deepEqual(msgs('def f():\n    return 1\nreturn 2\nif a:\n    pass\nelif b:\n    pass\nx = 1\nelif c:\n    pass', 'python'), ['return работает только внутри def', 'elif идёт только после if / elif']);
  assert.equal(S.templateFor('if', R('js')), 'if (…) {\n  …\n}');
});

test('атрибуты тегов: обязательные, необязательные, общие, значения, опечатки', async () => {
  const S = require('../public/structure-rules.js');
  const rules = S.parse(require('../public/dict/structure.json').html.join('\n')).rules;
  const A = S.attrsFor('img', rules);
  assert.deepEqual(A.required.map(x => x.name), ['src', 'alt']);
  assert.ok(A.optional.some(x => x.name === 'loading') && A.global.some(x => x.name === 'class'));
  assert.deepEqual(A.values('loading').list, ['lazy', 'eager']);
  const msgs = S.check('<img alt="x">\n<button tpye="button" type="sbmit">ok</button>\n<a href="/" data-x="1" onclick="f()" class="b">x</a>', 'html', rules).map(x => x.msg.split(' — ')[0]);
  assert.deepEqual(msgs, ['<img> без src', 'у <button> нет атрибута «tpye»', 'type="sbmit"']);
  const { buildVariants } = await import('../lib/variant-tree.mjs');
  const d = { langs: { html: { img: '<img> — картинка' } }, structure: require('../public/dict/structure.json') };
  const r = buildVariants({ q: 'картинка', lang: 'html', dict: d, rows: [], synonyms: { '<img>': ['картинка'] } });
  assert.equal(r.roots[0].code, '<img src="…" alt="…">');
  assert.match(r.roots[0].note, /обязательно: src, alt/);
});

test('форма кода и параметры: скобки после if, «:» в Python, «:»/«;» и значения в CSS, параметры функций', () => {
  const S = require('../public/structure-rules.js'); const d = require('../public/dict/structure.json');
  const R = l => S.parse(d[l].join('\n')).rules;
  const m = (c, l) => S.check(c, l, R(l)).map(x => x.msg.split(' — ')[0]);
  assert.deepEqual(m('if x > 1 {\n}\nif (y) {\n} else {\n}\nwhile(true){}', 'js'), ['после if нужны круглые скобки: if (…)']);
  assert.deepEqual(m('if x > 1\n    pass\nif y: z()\nelse\n    pass\ndef f(a,\n      b):\n    pass', 'python'), ['в конце строки с if нужно «:»', 'в конце строки с else нужно «:»']);
  assert.deepEqual(m('.a {\n  display flex;\n  color: red\n  margin: 0;\n  position: relativ;\n  width: var(--w);\n}', 'css'), ['после «display» нужно «:»', 'в конце нет «;»', 'position: «relativ»']);
  const A = S.attrsFor('addEventListener', R('js'));
  assert.deepEqual(A.required.map(x => x.name), ['type', 'listener']);
  assert.ok(A.values('type').list.includes('click'));
  assert.ok(S.attrsFor('display', R('css')).values('').list.includes('flex'));
  assert.deepEqual(S.attrsFor('open', R('python')).values('mode').list.slice(0, 3), ['r', 'w', 'a']);
});

test('правила структуры: повторная запись не дублирует и не стирает', () => {
  const S = require('../public/structure-rules.js');
  const base = ['img: обязательно src — путь', 'img: обязательно alt', 'img: можно width, height', 'img[loading]: значения lazy, eager', 'li: внутри ul, ol', 'if: пишется if (…) {\\n  …\\n}'];
  let r = S.merge(base, base.join('\n'));
  assert.deepEqual(r.lines, base); assert.equal(r.same, 6); assert.equal(r.added + r.replaced, 0);
  r = S.merge(base, 'img: обязательно alt\nimg: можно title, width\nimg[loading]: значения auto\nli: внутри menu\nif: пишется if (…) { … }\nx: пишется y');
  assert.ok(r.lines.includes('img: обязательно src — путь'), 'src не стёрт');
  assert.ok(r.lines.includes('img: можно title'));
  assert.ok(r.lines.includes('img[loading]: значения lazy, eager, auto'));
  assert.ok(r.lines.includes('li: внутри ul, ol, menu'));
  assert.ok(r.lines.includes('if: пишется if (…) { … }'));
  assert.equal(r.lines.length, base.length + 2);
  assert.equal(S.merge(r.lines, 'img: удалить').lines.filter(l => /^img[:[]/.test(l)).length, 0);
});

test('правила структуры: синонимы видов, «:» в имени, разметка ответа ИИ', () => {
  const S = require('../public/structure-rules.js');
  const r = S.parse(['a:hover: требует cursor: pointer', '::before: требует content', '- li: только внутри ul, ol', '1. p: не может содержать div, p', '`img`: обязательные атрибуты: src, alt', 'img: необязательные: width; height', 'button[type]: допустимые значения button | submit | reset.', 'summary: должен быть первым в details', 'gap: нужно display: flex | grid', 'что-то: странное правило'].join('\n'));
  assert.deepEqual(r.rules.filter(x => x.verb !== 'заметка').map(x => x.raw), ['a:hover: требует cursor: pointer', '::before: требует content', 'li: внутри ul, ol', 'p: не содержит div, p', 'img: обязательно src, alt', 'img: можно width, height', 'button[type]: значения button, submit, reset', 'summary: первым в details', 'gap: требует display: flex | grid']);
  assert.equal(r.bad.length, 0); assert.equal(r.rules[r.rules.length - 1].verb, 'заметка');
});

test('правила структуры: описания вместо имён не проверяются, имена в той же строке — да', () => {
  const S = require('../public/structure-rules.js');
  const rules = S.parse(['a: внутри потокового содержимого', 'div: внутри body, main, li', 'li: внутри ul, ol', 'a: не содержит a, button, другие интерактивные элементы', 'title: обязательно один элемент title на документ', 'label[for]: значения совпадает с id элемента'].join('\n')).rules;
  assert.deepEqual(rules.map(S.inert), [true, true, false, false, true, true]);
  const m = S.check('<div><div><a href="/"><button>b</button></a></div></div>\n<title>t</title>\n<label for="x">y</label>\n<li>z</li>', 'html', rules).map(x => x.msg.split(' — ')[0]);
  assert.deepEqual(m, ['<a> не может содержать <button>', '<li> должен быть внутри <ul>, <ol>']);
});
