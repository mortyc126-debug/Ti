// Тесты файлового хранилища. Запуск: node tools/code-lab/tests/library-store.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLibraryStore } from '../lib/library-store.mjs';
import { tokenize } from '../lib/tokenizer.mjs';

const DICT = { words: { print: 'print — вывод' }, cssProps: { 'font-weight': 'font-weight — жирность шрифта' } };
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-store-'));
const mk = (root = path.join(tmp, 'lib'), options = {}) => createLibraryStore({ root, getDict: async () => DICT, ...options });
const tt = t => (t.v != null ? String(t.v) : (t.k === 'sp' ? ' ' : ''));
const codeOf = lines => lines.map(l => l.map(tt).join('')).join('\n');
const tokenAt = (lines, text) => { for (const l of lines) for (const t of l) if (tt(t) === text) return t; return null; };
let n = 0;
const test = async (name, fn) => { try { await fn(); n++; } catch (e) { e.message = `[${name}] ` + e.message; throw e; } };
const exists = p => fs.access(p).then(() => true, () => false);

let store = mk(); await store.init();

await test('новый кусок — обычный файл с родным расширением и метафайл рядом', async () => {
  const code = 'const база = 20;\nprint(база)';
  await store.save({ id: 'тест-1', lang: 'js', title: 'Тест', group: 'Основы', desc: 'описание', lines: tokenize(code, 'js') });
  const p = path.join(tmp, 'lib', 'js', 'тест-1.js');
  assert.equal(await fs.readFile(p, 'utf8'), code);
  const meta = JSON.parse(await fs.readFile(p + '.meta.json', 'utf8'));
  assert.equal(meta.title, 'Тест'); assert.equal(meta.status, 'described'); assert.equal(meta.source.desc, 'manual');
  const t = await store.get('тест-1');
  assert.equal(codeOf(t.lines), code);
  assert.equal(tokenAt(t.lines, 'база').k, 'name');   // кириллическое имя — одно слово
  assert.equal(tokenAt(t.lines, 'print').e, 'print — вывод');   // подпись из словаря при загрузке
});

await test('ошибка записи паспорта откатывает уже записанный код и сохраняет старую пару', async () => {
  const root = path.join(tmp, 'rollback-existing');
  const stable = mk(root); await stable.init();
  await stable.save({ id: 'пара', lang: 'js', title: 'Старое', desc: 'Старое описание', lines: tokenize('const oldValue = 1;', 'js') });
  let fail = true;
  const faultStore = mk(root, { writeAtomicFile: async (p, content) => {
    if(fail && p.endsWith('.meta.json')) { fail = false; throw new Error('simulated passport write failure'); }
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf8');
  }});
  await faultStore.init();
  const changed = await faultStore.get('пара');
  changed.title = 'Новое'; changed.desc = 'Новое описание';
  changed.lines = tokenize('const newValue = 2;', 'js');
  await assert.rejects(faultStore.save(changed), /simulated passport write failure/);
  const check = mk(root); await check.init();
  const restored = await check.get('пара');
  assert.equal(codeOf(restored.lines), 'const oldValue = 1;');
  assert.equal(restored.title, 'Старое');
  assert.equal(restored.desc, 'Старое описание');
});

await test('частичная запись самого файла кода тоже откатывается вместе с паспортом', async () => {
  const root = path.join(tmp, 'rollback-partial-code');
  const stable = mk(root); await stable.init();
  await stable.save({ id: 'частичная-пара', lang: 'js', title: 'До сбоя', desc: 'Описание до сбоя', lines: tokenize('const safeValue = 7;', 'js') });
  let fail = true;
  const faultStore = mk(root, { writeAtomicFile: async (p, content) => {
    if(fail && p.endsWith('.js')) {
      fail = false;
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, 'const broken = ', 'utf8');
      throw new Error('simulated partial code write');
    }
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf8');
  }});
  await faultStore.init();
  const changed = await faultStore.get('частичная-пара');
  changed.lines = tokenize('const unsafeValue = 99;', 'js');
  changed.desc = 'Новое описание';
  await assert.rejects(faultStore.save(changed), /simulated partial code write/);
  const check = mk(root); await check.init();
  const restored = await check.get('частичная-пара');
  assert.equal(codeOf(restored.lines), 'const safeValue = 7;');
  assert.equal(restored.desc, 'Описание до сбоя');
});

await test('ошибка паспорта при создании удаляет частично созданный код', async () => {
  const root = path.join(tmp, 'rollback-new');
  let fail = true;
  const faultStore = mk(root, { writeAtomicFile: async (p, content) => {
    if(fail && p.endsWith('.meta.json')) { fail = false; throw new Error('simulated new passport failure'); }
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf8');
  }});
  await faultStore.init();
  await assert.rejects(faultStore.save({ id: 'новая-пара', lang: 'js', title: 'Новая', lines: tokenize('let x = 1;', 'js') }), /simulated new passport failure/);
  assert.equal(await exists(path.join(root, 'js', 'новая-пара.js')), false);
  assert.equal(await exists(path.join(root, 'js', 'новая-пара.js.meta.json')), false);
  const check = mk(root); await check.init();
  assert.equal(await check.has('новая-пара'), false);
});

await test('пояснение, вписанное вручную, переживает перезапуск', async () => {
  const t = await store.get('тест-1');
  tokenAt(t.lines, 'база').e = 'моя переменная';
  await store.save(t);
  const fresh = mk(); await fresh.init();
  assert.equal(tokenAt((await fresh.get('тест-1')).lines, 'база').e, 'моя переменная');
});

await test('правка кода: пояснение встаёт на то же слово, даже если оно сместилось', async () => {
  const t = await store.get('тест-1');
  t.lines = tokenize('// новая строка сверху\nconst база = 20;\nprint(база)', 'js');
  await store.save(t);
  const g = await store.get('тест-1');
  assert.equal(tokenAt(g.lines, 'база').e, 'моя переменная');
});

await test('слово исчезло — пояснение не теряется, а ждёт в orphanNotes и возвращается', async () => {
  let t = await store.get('тест-1');
  t.lines = tokenize('const x = 1;', 'js'); await store.save(t);
  const meta = JSON.parse(await fs.readFile(path.join(tmp, 'lib', 'js', 'тест-1.js.meta.json'), 'utf8'));
  assert.ok(meta.orphanNotes && meta.orphanNotes.some(o => o.note === 'моя переменная'));
  t = await store.get('тест-1');
  t.lines = tokenize('const база = 1;', 'js'); await store.save(t);
  assert.equal(tokenAt((await store.get('тест-1')).lines, 'база').e, 'моя переменная');
});

await test('стёртое пояснение остаётся стёртым и словарь его не возвращает', async () => {
  await store.save({ id: 'п-1', lang: 'js', title: 'п', lines: tokenize('print(1)', 'js') });
  const t = await store.get('п-1'); assert.equal(tokenAt(t.lines, 'print').e, 'print — вывод');
  tokenAt(t.lines, 'print').e = ''; await store.save(t);
  assert.equal(tokenAt((await store.get('п-1')).lines, 'print').e, '');
});

await test('файл, изменённый снаружи (в любом редакторе), виден без перезапуска', async () => {
  const p = path.join(tmp, 'lib', 'js', 'тест-1.js');
  await fs.writeFile(p, 'let внешнее = 5;\r\nprint(внешнее)\r\n', 'utf8');
  await store.refresh();
  const t = await store.get('тест-1');
  assert.equal(codeOf(t.lines), 'let внешнее = 5;\nprint(внешнее)\n');
  assert.equal(tokenAt(t.lines, 'внешнее').k, 'name');
});

await test('файл, положенный в папку руками, без метафайла, появляется в списке', async () => {
  await fs.mkdir(path.join(tmp, 'lib', 'css'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'lib', 'css', 'мой-стиль.css'), 'a { font-weight: 700; }\n', 'utf8');
  await store.refresh();
  const row = (await store.rows()).find(r => r.id === 'мой-стиль');
  assert.ok(row); assert.equal(row.lang, 'css'); assert.equal(row.status, 'needs_description');
  const t = await store.get('мой-стиль');
  assert.equal(tokenAt(t.lines, 'font-weight').e, 'font-weight — жирность шрифта');
  await store.save({ ...t, desc: 'теперь с описанием' });
  assert.ok(await exists(path.join(tmp, 'lib', 'css', 'мой-стиль.css.meta.json')));
});

await test('смена языка переносит файл в другую папку и убирает старый', async () => {
  const t = await store.get('п-1'); t.lang = 'python'; await store.save(t);
  assert.ok(await exists(path.join(tmp, 'lib', 'python', 'п-1.py')));
  assert.ok(!(await exists(path.join(tmp, 'lib', 'js', 'п-1.js'))));
  assert.ok(!(await exists(path.join(tmp, 'lib', 'js', 'п-1.js.meta.json'))));
  assert.equal((await store.rows()).filter(r => r.id === 'п-1').length, 1);
});

await test('удаление убирает и код, и метафайл', async () => {
  assert.equal(await store.remove('п-1'), true);
  assert.ok(!(await exists(path.join(tmp, 'lib', 'python', 'п-1.py'))));
  assert.equal(await store.has('п-1'), false);
  assert.equal(await store.remove('п-1'), false);
});

await test('двадцать параллельных записей не портят друг друга', async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.save({ id: 'пар-' + i, lang: 'js', title: 'п' + i, lines: tokenize('let a' + i + ' = ' + i + ';', 'js') })));
  const fresh = mk(); await fresh.init();
  const ids = (await fresh.rows()).map(r => r.id).filter(i => i.startsWith('пар-'));
  assert.equal(ids.length, 20);
  for (let i = 0; i < 20; i++) assert.equal(codeOf((await fresh.get('пар-' + i)).lines), 'let a' + i + ' = ' + i + ';');
});

await test('лишние поля в метафайле (теги, свои ключи) сохраняются при записи', async () => {
  const mp = path.join(tmp, 'lib', 'js', 'пар-0.js.meta.json');
  const m = JSON.parse(await fs.readFile(mp, 'utf8')); m.tags = ['тег']; m.свое = { x: 1 };
  await fs.writeFile(mp, JSON.stringify(m)); await store.refresh();
  const t = await store.get('пар-0'); assert.deepEqual(t.tags, ['тег']);
  await store.save({ ...t, desc: 'новое' });
  const m2 = JSON.parse(await fs.readFile(mp, 'utf8'));
  assert.deepEqual(m2.свое, { x: 1 }); assert.deepEqual(m2.tags, ['тег']);
});

await test('автор поля запоминается: imported не выдаёт себя за manual', async () => {
  await store.save({ id: 'имп-1', lang: 'js', title: 'и', desc: 'из архива', lines: tokenize('1', 'js') }, { origin: 'imported' });
  const m = JSON.parse(await fs.readFile(path.join(tmp, 'lib', 'js', 'имп-1.js.meta.json'), 'utf8'));
  assert.equal(m.source.desc, 'imported');
});

await test('автомиграция: пустая library + templates/ → куски переносятся, карточки не трогаются', async () => {
  const legacy = path.join(tmp, 'tpl'); await fs.mkdir(legacy, { recursive: true });
  const card = { id: 'старый', lang: 'python', group: 'Г', title: 'Старый', desc: 'д', lines: [[{ k: 'kw', v: 'for', e: 'цикл' }, { k: 'sp' }, { k: 'name', v: 'i', r: 'i' }]], output: '' };
  await fs.writeFile(path.join(legacy, 'старый.json'), JSON.stringify(card));
  const s = createLibraryStore({ root: path.join(tmp, 'lib2'), legacyDir: legacy, getDict: async () => ({}) });
  const r = await s.init(); assert.equal(r.migrated.created, 1);
  assert.equal(await fs.readFile(path.join(tmp, 'lib2', 'python', 'старый.py'), 'utf8'), 'for i');   // sp без v = пробел
  assert.equal(tokenAt((await s.get('старый')).lines, 'for').e, 'цикл');
  assert.equal(JSON.parse(await fs.readFile(path.join(legacy, 'старый.json'), 'utf8')).id, 'старый');
});


await test('больше пятидесяти непривязанных пояснений не теряются при сохранении', async () => {
  const notes = Array.from({ length: 60 }, (_, i) => ({
    line: 0, col: i, text: 'missingToken' + i, note: 'пояснение ' + i, source: 'custom'
  }));
  await store.save({
    id: 'много-сирот', lang: 'js', title: 'Много заметок',
    lines: tokenize('const present = 1;', 'js'), wordNotes: notes
  });
  const file = path.join(tmp, 'lib', 'js', 'много-сирот.js.meta.json');
  let meta = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(meta.orphanNotes.length, 60);
  await store.save(await store.get('много-сирот'));
  meta = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(meta.orphanNotes.length, 60);
  assert.equal(meta.orphanNotes[59].note, 'пояснение 59');
});

await fs.rm(tmp, { recursive: true, force: true });
console.log(`library-store: ${n} проверок пройдено`);
