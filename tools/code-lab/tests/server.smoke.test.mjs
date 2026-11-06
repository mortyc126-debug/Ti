// Сквозной тест сервера по HTTP на временной копии. Запуск: node tools/code-lab/tests/server.smoke.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.resolve(HERE, '..', '..');                      // tools/
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-smoke-'));
const T = path.join(tmp, 'tools'), L = path.join(T, 'code-lab');
await fs.mkdir(path.join(L, 'public'), { recursive: true });
await fs.mkdir(path.join(L, 'templates'), { recursive: true });
await fs.copyFile(path.join(TOOLS, 'code-lab-server.mjs'), path.join(T, 'code-lab-server.mjs'));
await fs.cp(path.join(TOOLS, 'code-lab', 'lib'), path.join(L, 'lib'), { recursive: true });
await fs.writeFile(path.join(L, 'public', 'index.html'), '<!doctype html><title>t</title>');
await fs.copyFile(path.join(TOOLS, 'code-lab', 'public', 'tasks-format.js'), path.join(L, 'public', 'tasks-format.js'));   // общий формат задач (сервер и браузер)
for(const f of ['code-links.js', 'structure-rules.js']) await fs.copyFile(path.join(TOOLS, 'code-lab', 'public', f), path.join(L, 'public', f));   // связи и правила структуры — общие для сервера и страницы
await fs.writeFile(path.join(L, 'public', 'keyword-dict.json'), JSON.stringify({ words: { print: 'print — вывод' }, cssProps: { 'font-weight': 'font-weight — жирность шрифта' } }));
// две старые карточки: автомиграция должна перенести их в library/
const card = (id, title, lang, code, desc, group) => ({ id, lang, group, title, desc, output: '', lines: code.split('\n').map(l => [{ k: 'name', v: l, r: l }]) });
await fs.writeFile(path.join(L, 'templates', 'a.json'), JSON.stringify(card('css-bold', 'жирный', 'css', 'p { font-weight: 700; }', 'Делает текст жирным', 'CSS: шрифты')));
await fs.writeFile(path.join(L, 'templates', 'b.json'), JSON.stringify(card('py-loop', 'цикл', 'python', 'for i in range(3):\n    print(i)', 'Повторяет', 'Основы')));

const port = 18700 + Math.floor(Math.random() * 200);
const srv = spawn(process.execPath, [path.join(T, 'code-lab-server.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 60 && !log.includes('Лаборатория кода'); i++) await new Promise(r => setTimeout(r, 100));
assert.ok(log.includes('Лаборатория кода'), 'сервер не запустился:\n' + log);

const get = async u => (await fetch(base + u)).json();
const post = async (u, b) => (await fetch(base + u, { method: 'POST', body: JSON.stringify(b) })).json();
const tt = t => (t.v != null ? String(t.v) : (t.k === 'sp' ? ' ' : ''));
const find = (lines, text) => { for (const l of lines) for (const t of l) if (tt(t) === text) return t; return null; };
let n = 0;
const test = async (name, fn) => { try { await fn(); n++; } catch (e) { e.message = `[${name}] ` + e.message; throw e; } };

try {
  await test('первый запуск переносит templates/ в library/, карточки не трогает', async () => {
    assert.ok(log.includes('перенесено в library/: 2'));
    assert.equal((await get('/api/list')).length, 2);
    assert.ok((await fs.readFile(path.join(L, 'library', 'css', 'css-bold.css'), 'utf8')).includes('font-weight'));
    assert.equal(JSON.parse(await fs.readFile(path.join(L, 'templates', 'a.json'), 'utf8')).id, 'css-bold');
  });

  await test('список и шаблон в прежнем формате', async () => {
    const row = (await get('/api/list')).find(r => r.id === 'py-loop');
    for (const k of ['id', 'lang', 'group', 'title', 'desc', 'file', 'nlines', 'cov']) assert.ok(k in row, k);
    const t = await get('/api/template?id=py-loop');
    assert.ok(Array.isArray(t.lines) && t.lines.length === 2);
    assert.equal(find(t.lines, 'print').e, 'print — вывод');       // подпись из словаря
    assert.equal((await fetch(base + '/api/template?id=нет')).status, 404);
  });

  let newId, protectedId;
  await test('добавление: файл на диске, дубль не плодится', async () => {
    const r = await post('/api/add', { title: 'Моё', lang: 'js', code: 'const база = 1;\nconsole.log(база)', desc: 'тест', group: 'Мои' });
    newId = r.id; assert.ok(newId);
    assert.equal(await fs.readFile(path.join(L, 'library', 'js', newId + '.js'), 'utf8'), 'const база = 1;\nconsole.log(база)');
    const again = await post('/api/add', { title: 'Моё', lang: 'js', code: 'const база = 1;\nconsole.log(база)' });
    assert.equal(again.dedup, true); assert.equal((await get('/api/list')).length, 3);
    assert.equal(find((await get('/api/template?id=' + encodeURIComponent(newId))).lines, 'база').k, 'name');
  });

  await test('пояснение к слову сохраняется и переживает правку кода', async () => {
    const t = await get('/api/template?id=' + encodeURIComponent(newId));
    let li = -1, idx = -1; t.lines.forEach((l, i) => l.forEach((k, j) => { if (li < 0 && tt(k) === 'база') { li = i; idx = j; } }));
    assert.ok((await post('/api/annotate', { id: newId, line: li, idx, e: 'моя переменная' })).ok);
    assert.ok((await post('/api/edit', { id: newId, code: '// шапка\nconst база = 2;\nconsole.log(база)' })).ok);
    const t2 = await get('/api/template?id=' + encodeURIComponent(newId));
    assert.equal(find(t2.lines, 'база').e, 'моя переменная');
    assert.ok((await fs.readFile(path.join(L, 'library', 'js', newId + '.js'), 'utf8')).startsWith('// шапка'));
  });

  await test('правка названия, описания и языка', async () => {
    assert.ok((await post('/api/edit', { id: newId, title: 'Новое имя', desc: 'новое описание', lang: 'python' })).ok);
    const row = (await get('/api/list')).find(r => r.id === newId);
    assert.equal(row.title, 'Новое имя'); assert.equal(row.lang, 'python');
    await fs.access(path.join(L, 'library', 'python', newId + '.py'));
    await assert.rejects(fs.access(path.join(L, 'library', 'js', newId + '.js')));
  });

  await test('поиск: по коду, по словоформе, по синониму; синонимы лежат рядом с библиотекой', async () => {
    const q = async s => (await get('/api/search?q=' + encodeURIComponent(s))).hits.map(h => h.id);
    assert.ok((await q('font-weight')).includes('css-bold'));
    assert.ok((await q('жирного')).includes('css-bold'));
    assert.ok((await q('толщина букв')).includes('css-bold'));
    assert.ok((await q('цикл')).includes('py-loop'));
    await fs.access(path.join(L, 'library', '_synonyms.json'));
    const r = await get('/api/search?q=' + encodeURIComponent('толщина'));
    assert.ok(r.hits[0].why.length > 0 && r.terms.length === 1);
  });

  await test('правка файла синонимов подхватывается без перезапуска', async () => {
    const p = path.join(L, 'library', '_synonyms.json');
    const j = JSON.parse(await fs.readFile(p, 'utf8')); j.groups.push(['веселье', 'жирный']);
    await new Promise(r => setTimeout(r, 30)); await fs.writeFile(p, JSON.stringify(j));
    const r = await get('/api/search?q=' + encodeURIComponent('веселье'));
    assert.ok(r.hits.some(h => h.id === 'css-bold'));
  });

  await test('файл, положенный в library/ руками, появляется сам', async () => {
    await fs.writeFile(path.join(L, 'library', 'css', 'мой-ручной.css'), 'a { text-shadow: 0 0 2px red; }\n');
    await new Promise(r => setTimeout(r, 1200));
    assert.ok((await get('/api/list')).some(r => r.id === 'мой-ручной'));
    assert.ok((await get('/api/search?q=text-shadow')).hits.some(h => h.id === 'мой-ручной'));
  });

  await test('импорт сборника и дедуп', async () => {
    const r = await post('/api/import', { pieces: [{ title: 'Импорт 1', lang: 'js', code: 'let q = 1;', desc: 'из архива' }, { title: 'Импорт 2', lang: 'js', code: 'let q = 1;', desc: 'тот же код' }] });
    assert.equal(r.ok, true); assert.equal(r.created, 1); assert.equal(r.updated, 1);
    const metaName = (await fs.readdir(path.join(L, 'library', 'js'))).find(f => f.startsWith('импорт-1') && f.endsWith('.meta.json'));
    assert.ok(metaName, 'нет метафайла импортированного куска');
    assert.equal(JSON.parse(await fs.readFile(path.join(L, 'library', 'js', metaName), 'utf8')).source.desc, 'imported');   // автор — «из архива», не «вы»
    const d = await post('/api/dedup', {}); assert.equal(d.ok, true);
  });

  await test('дедупликация не смешивает одинаковый код разных языков', async () => {
    const source = 'print("одинаковый текст")';
    const js = await post('/api/add', { title: 'Одинаковый текст JS', lang: 'js', code: source });
    const py = await post('/api/add', { title: 'Одинаковый текст Python', lang: 'python', code: source });
    assert.ok(js.id && py.id && js.id !== py.id, 'для разных языков создаются разные куски');
    protectedId = js.id;
    assert.equal((await get('/api/template?id=' + encodeURIComponent(js.id))).lang, 'js');
    assert.equal((await get('/api/template?id=' + encodeURIComponent(py.id))).lang, 'python');

    const imported = await post('/api/import', { pieces: [{ title: 'Обновлённый Python', lang: 'python', code: source, desc: 'обновление того же языка' }] });
    assert.equal(imported.created, 0);
    assert.equal(imported.updated, 1);
    assert.equal((await get('/api/template?id=' + encodeURIComponent(js.id))).lang, 'js', 'импорт Python не меняет язык JS-куска');
    assert.equal((await get('/api/template?id=' + encodeURIComponent(py.id))).lang, 'python');
  });

  await test('импорт рецепта останавливается на неоднозначных названиях до подтверждения', async () => {
    await fs.mkdir(path.join(L, 'library', 'js'), { recursive: true });
    for(const [id, code] of [['recipe-title-a', 'const recipeA = 1;'], ['recipe-title-b', 'const recipeB = 2;']]){
      await fs.writeFile(path.join(L, 'library', 'js', id + '.js'), code);
      await fs.writeFile(path.join(L, 'library', 'js', id + '.js.meta.json'), JSON.stringify({
        id, lang: 'js', title: 'Одинаковый компонент', group: 'Тест', desc: 'Для неоднозначного импорта', tags: [], aliases: []
      }));
    }
    await new Promise(r => setTimeout(r, 1100));
    await get('/api/list');
    const before = (await fs.readdir(path.join(L, 'recipes')).catch(() => [])).filter(x => x.endsWith('.json')).length;
    const preview = await post('/api/recipes/import', { title: 'Неполный рецепт', items: [{ title: 'Одинаковый компонент' }] });
    assert.equal(preview.ok, false);
    assert.equal(preview.needsConfirmation, true);
    assert.equal(preview.itemsUnresolved, 1);
    assert.equal(preview.unresolved[0].reason, 'неоднозначное название');
    const afterPreview = (await fs.readdir(path.join(L, 'recipes')).catch(() => [])).filter(x => x.endsWith('.json')).length;
    assert.equal(afterPreview, before, 'без подтверждения рецепт не должен сохраняться');

    const confirmed = await post('/api/recipes/import', { title: 'Неполный рецепт', items: [{ title: 'Одинаковый компонент' }], allowUnresolved: true });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.itemsUnresolved, 1);
    const names = (await fs.readdir(path.join(L, 'recipes'))).filter(x => x.endsWith('.json'));
    let saved = null;
    for(const name of names){ const value = JSON.parse(await fs.readFile(path.join(L, 'recipes', name), 'utf8')); if(value.title === 'Неполный рецепт') saved = value; }
    assert.ok(saved);
    assert.equal(saved.items[0].id, '');
  });

  await test('импорт сохраняет полный паспорт и не затирает ручные поля', async () => {
    const imported = await post('/api/import', { pieces: [{
      lang: 'js', title: 'Полный паспорт', group: 'Проверка импорта', desc: 'Ручное описание',
      code: 'const passportValue = 7;', output: 'готово', tags: ['важный'], aliases: ['псевдоним'],
      source: { title: 'manual', desc: 'manual', tags: 'manual' },
      wordNotes: [{ line: 0, col: 6, text: 'passportValue', note: 'Пояснение к токену', source: 'custom' }],
      orphanNotes: [{ line: 20, col: 0, text: 'missingToken', note: 'Осиротевшее пояснение', source: 'custom' }],
      labels: { passportValue: 'Значение паспорта' },
      component: { summary: 'Контракт компонента', provides: ['passportValue'], requires: [] },
      status: 'described', descAt: 12345,
      meta: { legacyField: { keep: true } }, passport: { passportField: 'сохранить' },
      customField: { version: 7 }
    }] });
    assert.equal(imported.created, 1);
    const list = await get('/api/list?labels=1');
    const item = list.find(x => x.title === 'Полный паспорт');
    assert.ok(item);
    const file = item.file || (item.id + '.js');
    const metaPath = path.join(L, 'library', 'js', file + '.meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    assert.deepEqual(meta.tags, ['важный']);
    assert.deepEqual(meta.aliases, ['псевдоним']);
    assert.equal(meta.source.title, 'manual');
    assert.equal(meta.source.desc, 'manual');
    assert.equal(meta.wordNotes.some(x => x.text === 'passportValue' && x.note === 'Пояснение к токену'), true);
    assert.equal(meta.orphanNotes.some(x => x.text === 'missingToken'), true);
    assert.equal(meta.labels.passportValue, 'Значение паспорта');
    assert.equal(meta.component.summary, 'Контракт компонента');
    assert.equal(meta.status, 'described');
    assert.equal(meta.descAt, 12345);
    assert.equal(meta.legacyField.keep, true);
    assert.equal(meta.passportField, 'сохранить');
    assert.equal(meta.customField.version, 7);

    const update = await post('/api/import', { pieces: [{
      lang: 'js', title: 'Импортированное новое название', desc: 'Импортированное описание',
      code: 'const passportValue = 7;', tags: ['чужой тег'], source: { title: 'imported', desc: 'imported', tags: 'imported' }
    }] });
    assert.equal(update.updated, 1);
    const after = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    assert.equal(after.title, 'Полный паспорт', 'импорт не должен затирать ручное название');
    assert.equal(after.desc, 'Ручное описание', 'импорт не должен затирать ручное описание');
    assert.deepEqual(after.tags, ['важный'], 'импорт не должен затирать ручные теги');
    assert.equal(after.source.title, 'manual');
    assert.equal(after.source.desc, 'manual');
  });

  await test('одноимённые наборы, рецепты и схемы получают разные ID', async () => {
    const d1 = await post('/api/data/save', { name: 'Повторяющийся набор', data: { version: 1 } });
    const d2 = await post('/api/data/save', { name: 'Повторяющийся набор', data: { version: 2 } });
    assert.ok(d1.id && d2.id && d1.id !== d2.id);
    assert.equal(JSON.parse(await fs.readFile(path.join(L, 'data', d1.id + '.json'), 'utf8')).data.version, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(L, 'data', d2.id + '.json'), 'utf8')).data.version, 2);

    const r1 = await post('/api/recipes/save', { title: 'Повторяющийся рецепт', items: [] });
    const r2 = await post('/api/recipes/save', { title: 'Повторяющийся рецепт', items: [] });
    assert.ok(r1.ok && r2.ok && r1.id !== r2.id);
    await fs.access(path.join(L, 'recipes', r1.id + '.json'));
    await fs.access(path.join(L, 'recipes', r2.id + '.json'));

    const f1 = await post('/api/flows/save', { name: 'Повторяющаяся схема', graph: { nodes: [], edges: [] } });
    const f2 = await post('/api/flows/save', { name: 'Повторяющаяся схема', graph: { nodes: [], edges: [] } });
    assert.ok(f1.ok && f2.ok && f1.id !== f2.id);
    await fs.access(path.join(L, 'flows', f1.id + '.json'));
    await fs.access(path.join(L, 'flows', f2.id + '.json'));
  });

  await test('удаление и дедупликация защищают куски со ссылками', async () => {
    await fs.mkdir(path.join(L, 'recipes'), { recursive: true });
    await fs.writeFile(path.join(L, 'recipes', 'uses-piece.json'), JSON.stringify({ id: 'uses-piece', title: 'Рецепт со ссылкой', items: [{ id: protectedId, title: 'Кусок' }] }));
    await fs.mkdir(path.join(L, 'flows'), { recursive: true });
    await fs.writeFile(path.join(L, 'flows', 'uses-piece.json'), JSON.stringify({ id: 'flow-uses-piece', name: 'Схема со ссылкой', graph: { nodes: [{ id: 'node-1', src: { id: protectedId, title: 'Кусок' } }], edges: [] } }));
    await fs.mkdir(path.join(L, 'public', 'dict'), { recursive: true });
    await fs.writeFile(path.join(L, 'public', 'dict', 'examples.json'), JSON.stringify({ print: { id: protectedId, title: 'Кусок' } }));

    const deleted = await post('/api/delete', { id: protectedId });
    assert.equal(deleted.ok, false);
    const types = new Set((deleted.references || []).map(x => x.type));
    assert.ok(types.has('recipe'));
    assert.ok(types.has('flow'));
    assert.ok(types.has('dictionary-example'));
    await fs.access(path.join(L, 'library', 'js', protectedId + '.js'));

    const duplicateId = 'duplicate-of-protected';
    await fs.writeFile(path.join(L, 'library', 'js', duplicateId + '.js'), 'print("одинаковый текст")');
    await fs.writeFile(path.join(L, 'library', 'js', duplicateId + '.js.meta.json'), JSON.stringify({
      id: duplicateId, lang: 'js', title: 'Дубль защищённого куска', group: 'Тест', desc: 'Дубликат для проверки ссылок', tags: [], aliases: []
    }));
    await new Promise(r => setTimeout(r, 1100));
    await get('/api/list');
    const preview = await post('/api/dedup', { dry: true });
    assert.equal(preview.ok, true);
    assert.equal(preview.dry, true);
    assert.equal(preview.removed, 0);
    assert.ok(preview.blocked >= 1);
    await fs.access(path.join(L, 'library', 'js', duplicateId + '.js'));
    const dedup = await post('/api/dedup', {});
    assert.equal(dedup.ok, true);
    assert.equal(dedup.removed, 0);
    assert.ok(dedup.blocked >= 1);
    assert.ok(dedup.blockedGroups.some(g => g.ids.includes(protectedId)));
    await fs.access(path.join(L, 'library', 'js', duplicateId + '.js'));
  });

  await test('восстановление архива сохраняет пути и резервирует перезаписи', async () => {
    const oldMeta = { schema: 1, id: 'restore-js-shared', lang: 'js', title: 'Старый JS', group: 'Тест', desc: 'старый файл', tags: [], aliases: [] };
    await fs.mkdir(path.join(L, 'library', 'js'), { recursive: true });
    await fs.writeFile(path.join(L, 'library', 'js', 'shared.js'), 'const oldJs = true;');
    await fs.writeFile(path.join(L, 'library', 'js', 'shared.js.meta.json'), JSON.stringify(oldMeta));
    const meta = (id, lang, title) => JSON.stringify({ schema: 1, id, lang, title, group: 'Восстановление', desc: 'Тестовый файл', tags: [], aliases: [] });
    const files = [
      { name: 'library/js/shared.js.meta.json', text: meta('restore-js-shared', 'js', 'JS из архива') },
      { name: 'library/js/shared.js', text: 'const restoredJs = true;' },
      { name: 'library/ts/shared.js.meta.json', text: meta('restore-ts-shared', 'ts', 'TS из архива') },
      { name: 'library/ts/shared.js', text: 'const restoredTs: number = 1;' }
    ];
    const restored = await post('/api/library/restore', { files });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.pairs, 2);
    assert.equal(restored.overwritten, 2);
    assert.ok(restored.backupId);
    assert.equal(await fs.readFile(path.join(L, 'library', 'js', 'shared.js'), 'utf8'), 'const restoredJs = true;');
    assert.equal(await fs.readFile(path.join(L, 'library', 'ts', 'shared.js'), 'utf8'), 'const restoredTs: number = 1;');
    assert.equal(JSON.parse(await fs.readFile(path.join(L, 'library', 'js', 'shared.js.meta.json'), 'utf8')).id, 'restore-js-shared');
    assert.equal(JSON.parse(await fs.readFile(path.join(L, 'library', 'ts', 'shared.js.meta.json'), 'utf8')).id, 'restore-ts-shared');
    assert.equal(await fs.readFile(path.join(L, 'data', 'restore-backups', restored.backupId, 'js', 'shared.js'), 'utf8'), 'const oldJs = true;');

    const bad = await fetch(base + '/api/library/restore', { method: 'POST', body: JSON.stringify({ files: [{ name: '../../escape.js', text: 'bad' }] }) });
    assert.equal(bad.status, 400, 'путь за пределами архива должен отклоняться');
    await assert.rejects(fs.access(path.join(tmp, 'escape.js')));

    const outside = path.join(tmp, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(L, 'library', 'js', 'linked'), 'dir');
    const linked = await post('/api/library/restore', { files: [{ name: 'library/js/linked/out.js', text: 'outside' }] });
    assert.equal(linked.ok, false, 'символические ссылки в пути назначения должны отклоняться');
    await assert.rejects(fs.access(path.join(outside, 'out.js')));
  });

  await test('полный бэкап экспортирует хранилища и безопасно восстанавливает данные', async () => {
    await fs.mkdir(path.join(L, 'workspace'), { recursive: true });
    await fs.mkdir(path.join(L, 'data'), { recursive: true });
    await fs.writeFile(path.join(L, 'workspace', 'backup-sample.js'), 'const backupSample = true;');
    await fs.writeFile(path.join(L, 'data', 'backup-check.json'), JSON.stringify({ value: 'old' }));

    const response = await fetch(base + '/api/backup/export');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /application\/zip/);
    const zip = Buffer.from(await response.arrayBuffer());
    assert.equal(zip.readUInt32LE(0), 0x04034b50, 'должен скачиваться ZIP-архив');
    assert.ok(zip.includes(Buffer.from('backup-manifest.json')));
    const zipEntries = new Map();
    let zipOffset = 0;
    while(zipOffset + 30 < zip.length && zip.readUInt32LE(zipOffset) === 0x04034b50){
      const size = zip.readUInt32LE(zipOffset + 18), nameLen = zip.readUInt16LE(zipOffset + 26), extraLen = zip.readUInt16LE(zipOffset + 28);
      const name = zip.subarray(zipOffset + 30, zipOffset + 30 + nameLen).toString('utf8');
      const dataStart = zipOffset + 30 + nameLen + extraLen;
      zipEntries.set(name, zip.subarray(dataStart, dataStart + size));
      zipOffset = dataStart + size;
    }
    assert.equal(zip.readUInt32LE(zipOffset), 0x02014b50, 'после локальных записей должен идти центральный каталог');
    const manifest = JSON.parse(zipEntries.get('backup-manifest.json').toString('utf8'));
    assert.equal(manifest.format, 'code-lab-full-backup');
    assert.ok(manifest.fileCount > 0);
    assert.ok(zip.includes(Buffer.from('library/js/shared.js')));
    assert.ok(zip.includes(Buffer.from('workspace/backup-sample.js')));
    assert.ok(zip.includes(Buffer.from('recipes/')));
    assert.ok(zip.includes(Buffer.from('flows/')));
    assert.ok(zip.includes(Buffer.from('public/dict/examples.json')));
    assert.ok(!zip.includes(Buffer.from('restore-backups/')), 'в архив не должны попадать предыдущие резервные копии');

    const restored = await post('/api/backup/restore', { files: [{ name: 'data/backup-check.json', text: JSON.stringify({ value: 'new' }) }] });
    assert.equal(restored.ok, true);
    assert.equal(restored.written, 1);
    assert.equal(restored.overwritten, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(L, 'data', 'backup-check.json'), 'utf8')).value, 'new');
    assert.equal(JSON.parse(await fs.readFile(path.join(L, 'data', 'restore-backups', restored.backupId, 'data', 'backup-check.json'), 'utf8')).value, 'old');

    const invalid = await post('/api/backup/restore', { files: [{ name: '../../outside.json', text: '{}' }] });
    assert.equal(invalid.ok, false);
    await assert.rejects(fs.access(path.join(tmp, 'outside.json')));

    const outside = path.join(tmp, 'outside-full');
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(L, 'workspace', 'linked'), 'dir');
    const linked = await post('/api/backup/restore', { files: [{ name: 'workspace/linked/out.js', text: 'outside' }] });
    assert.equal(linked.ok, false);
    await assert.rejects(fs.access(path.join(outside, 'out.js')));
  });

  await test('удаление убирает файлы', async () => {
    assert.ok((await post('/api/delete', { id: newId })).ok);
    await assert.rejects(fs.access(path.join(L, 'library', 'python', newId + '.py')));
    assert.equal((await fetch(base + '/api/template?id=' + encodeURIComponent(newId))).status, 404);
  });

  await test('ingest: txt со списком кусков → файлы, повтор не плодит дубли', async () => {
    const text = '=== жирный курсив | css | Текст\nописание: наклон и жирность\nтеги: шрифт, толщина\n.x { font-weight: 700; font-style: italic; }\n\n=== Сумма\nlet total = a + b;\n\n=== Пусто\n';
    const dry = await post('/api/ingest', { text, dry: true });
    assert.equal(dry.created, 2); assert.equal(dry.dry, true); assert.equal(dry.warnings.length, 1);
    assert.equal((await get('/api/list')).some(r => r.title === 'Сумма'), false, 'dry ничего не пишет');
    const r = await post('/api/ingest', { text });
    assert.equal(r.created, 2); assert.equal(r.needDescription, 1);
    const row = (await get('/api/list')).find(x => x.title === 'жирный курсив');
    assert.equal(row.lang, 'css'); assert.equal(row.group, 'Текст');
    const f = (await fs.readdir(path.join(L, 'library', 'css'))).find(x => x.startsWith('жирный-курсив') && x.endsWith('.meta.json'));
    const meta = JSON.parse(await fs.readFile(path.join(L, 'library', 'css', f), 'utf8'));
    assert.deepEqual(meta.tags, ['шрифт', 'толщина']); assert.equal(meta.source.tags, 'manual'); assert.equal(meta.desc, 'наклон и жирность');
    assert.equal((await get('/api/search?q=толщина')).hits.some(h => h.id === row.id), true, 'тег ищется сразу');
    const again = await post('/api/ingest', { text });
    assert.equal(again.created, 0); assert.equal(again.duplicates, 2);
  });

  await test('статика и git-сводка отвечают', async () => {
    assert.equal((await fetch(base + '/')).status, 200);
    const g = await get('/api/git/info'); assert.ok('templates' in g && g.templates >= 3);
  });
} finally {
  srv.kill();
  await fs.rm(tmp, { recursive: true, force: true });
}
console.log(`server: ${n} сценариев пройдено`);
