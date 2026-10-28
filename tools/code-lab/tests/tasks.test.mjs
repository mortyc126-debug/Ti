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

test('хранилище: ссылки на куски и задачи привязываются, «код» становится куском, повторный импорт не плодит двойники', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tasks-'));
  const rows = [{ id: 'el-1', title: 'Найти элемент', lang: 'js', comp: { provides: ['el'], requires: [] } },
                { id: 'click-1', title: 'Клик', lang: 'js', comp: { provides: [], requires: ['btn'] } }];
  let n = 0; const created = [];
  const store = createTaskStore({ root, rows: async () => rows, slug: s => s.replace(/\s+/g, '-') + '-' + (++n),
    createPiece: async p => { const id = 'new-' + created.length; created.push(p); rows.push({ id, title: p.title, lang: p.lang, comp: { provides: ['btn'], requires: [] } }); return { id, title: p.title, created: true }; } });
  const text = SAMPLE + '\n=== Показать блок | js | Интерфейс\n? Как?\n  - классом -> кусок: нет такого';
  const dry = await store.importText(text, { dry: true });
  assert.equal(dry.tasks.length, 2); assert.equal(created.length, 0, 'проверка ничего не создаёт');
  const r = await store.importText(text);
  assert.equal(created.length, 1);
  assert.equal(created[0].code.includes('getElementById'), true);
  const list = await store.list(); assert.equal(list.length, 2);
  const main = await store.get(list.find(t => t.title === 'Реагировать на клик').id);
  const o = main.steps[0].options;
  assert.equal(o[0].id, 'el-1'); assert.equal(o[1].kind, 'piece'); assert.equal(o[1].id, 'new-0');
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
