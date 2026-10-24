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

  let newId;
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
