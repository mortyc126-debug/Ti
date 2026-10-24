// Рабочая папка проекта (lib/workspace.mjs). Запуск: node tools/code-lab/tests/workspace.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleWorkspace } from '../lib/workspace.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-test-'));
const app = path.join(tmp, 'app'), proj = path.join(tmp, 'proj');
await fs.mkdir(app, { recursive: true }); await fs.mkdir(path.join(proj, 'src'), { recursive: true });
await fs.writeFile(path.join(proj, 'a.css'), 'a{b:c}\r\nd{e:f}\r\n');
await fs.writeFile(path.join(proj, 'src', 'x.js'), '\uFEFFlet x = 1;\n');
await fs.writeFile(path.join(proj, 'bin.dat'), Buffer.from([1, 0, 2]));
await fs.mkdir(path.join(proj, 'node_modules'), { recursive: true }); await fs.writeFile(path.join(proj, 'node_modules', 'z.js'), '1');

let n = 0;
const call = async (method, url, body) => {
  const u = new URL('http://x' + url); let out = null;
  const res = {}; const json = (r, code, obj) => { out = { code, obj }; };
  const handled = await handleWorkspace({ method }, res, u, { readBody: async () => body, json, root: app });
  return { handled, ...(out || {}) };
};
const test = async (name, fn) => { try { await fn(); n++; } catch (e) { e.message = `[${name}] ` + e.message; throw e; } };

try {
  await test('чужие маршруты не перехватываются', async () => { assert.equal((await call('GET', '/api/list')).handled, false); });

  await test('выбор папки: нужен полный путь, папка должна существовать', async () => {
    assert.equal((await call('POST', '/api/ws/root', { path: 'относительный/путь' })).code, 400);
    assert.equal((await call('POST', '/api/ws/root', { path: path.join(tmp, 'нет') })).code, 404);
    assert.equal((await call('POST', '/api/ws/root', { path: path.join(proj, 'a.css') })).code, 400);
    assert.equal((await call('POST', '/api/ws/root', { path: '"' + proj + '"' })).code, 200);        // путь в кавычках (копия из проводника)
    const info = (await call('GET', '/api/ws/info')).obj; assert.equal(info.root, proj); assert.equal(info.recent[0], proj);
    assert.ok(JSON.parse(await fs.readFile(path.join(app, 'workspace.json'), 'utf8')).root === proj);   // запомнилось
  });

  await test('дерево: папки вперёд, node_modules пропущены, двоичный не текстовый', async () => {
    const t = (await call('GET', '/api/ws/tree')).obj;
    const p = t.entries.map(e => e.path);
    assert.deepEqual(p, ['src', 'src/x.js', 'a.css', 'bin.dat']);
    assert.equal(t.entries.find(e => e.path === 'bin.dat').text, false);
  });

  await test('чтение: CRLF → LF с пометкой, BOM снимается, язык по расширению', async () => {
    const a = (await call('GET', '/api/ws/file?path=a.css')).obj;
    assert.equal(a.text, 'a{b:c}\nd{e:f}\n'); assert.equal(a.eol, 'crlf'); assert.equal(a.lang, 'css');
    const x = (await call('GET', '/api/ws/file?path=src/x.js')).obj;
    assert.equal(x.bom, true); assert.equal(x.text, 'let x = 1;\n'); assert.equal(x.lang, 'js');
    assert.equal((await call('GET', '/api/ws/file?path=bin.dat')).code, 415);
    assert.equal((await call('GET', '/api/ws/file?path=нет.txt')).code, 404);
  });

  await test('запись возвращает прежние переводы строк и BOM; на диске нет «смешанных» строк', async () => {
    const a = (await call('GET', '/api/ws/file?path=a.css')).obj;
    const r = await call('POST', '/api/ws/save', { path: 'a.css', text: a.text + 'g{h:i}\n', eol: a.eol, bom: a.bom, mtime: a.mtime });
    assert.equal(r.code, 200);
    assert.equal(await fs.readFile(path.join(proj, 'a.css'), 'utf8'), 'a{b:c}\r\nd{e:f}\r\ng{h:i}\r\n');
    await call('POST', '/api/ws/save', { path: 'src/x.js', text: 'let x = 2;\n', eol: 'lf', bom: true });
    assert.equal((await fs.readFile(path.join(proj, 'src', 'x.js'), 'utf8')).charCodeAt(0), 0xFEFF);
    const nw = await call('POST', '/api/ws/save', { path: 'глубоко/в/папке/new.py', text: 'print(1)\n' });
    assert.equal(nw.obj.created, true); assert.equal(await fs.readFile(path.join(proj, 'глубоко', 'в', 'папке', 'new.py'), 'utf8'), 'print(1)\n');
  });

  await test('конфликт: файл изменён снаружи → 409, без force не пишем, с force пишем', async () => {
    const a = (await call('GET', '/api/ws/file?path=a.css')).obj;
    const later = new Date(Date.now() + 10000); await fs.writeFile(path.join(proj, 'a.css'), 'внешняя правка\n'); await fs.utimes(path.join(proj, 'a.css'), later, later);
    const r = await call('POST', '/api/ws/save', { path: 'a.css', text: 'моя версия\n', eol: 'lf', mtime: a.mtime });
    assert.equal(r.code, 409); assert.equal(r.obj.conflict, true);
    assert.equal(await fs.readFile(path.join(proj, 'a.css'), 'utf8'), 'внешняя правка\n');
    assert.equal((await call('POST', '/api/ws/save', { path: 'a.css', text: 'моя версия\n', eol: 'lf', mtime: a.mtime, force: true })).code, 200);
  });

  await test('защита путей: .., абсолютные, диск Windows, .git, символическая ссылка наружу', async () => {
    for (const bad of ['../x.txt', 'a/../../x.txt', 'C:\\Windows\\x.txt', 'src/..\\..\\x'])
      assert.equal((await call('POST', '/api/ws/save', { path: bad, text: 'x' })).code, 400, bad);
    // ведущий «/» считается началом пути внутри проекта, а не корнем диска
    assert.equal((await call('POST', '/api/ws/save', { path: '/etc/passwd', text: 'x' })).obj.path, 'etc/passwd');
    assert.equal((await call('POST', '/api/ws/save', { path: '.git/config', text: 'x' })).code, 403);
    await fs.mkdir(path.join(tmp, 'outside')); 
    try { await fs.symlink(path.join(tmp, 'outside'), path.join(proj, 'link')); } catch (_) { return; }   // на системах без прав на ссылки — пропуск
    assert.equal((await call('POST', '/api/ws/save', { path: 'link/hack.txt', text: 'x' })).code, 403);
    await assert.rejects(fs.access(path.join(tmp, 'outside', 'hack.txt')));
  });

  await test('создать / переименовать / удалить (в корзину)', async () => {
    assert.equal((await call('POST', '/api/ws/create', { path: 'n.txt', text: 'q' })).code, 200);
    assert.equal((await call('POST', '/api/ws/create', { path: 'n.txt' })).code, 409, 'не затирает существующий');
    assert.equal((await call('POST', '/api/ws/rename', { from: 'n.txt', to: 'sub/m.txt' })).code, 200);
    assert.equal((await call('POST', '/api/ws/rename', { from: 'sub/m.txt', to: 'a.css' })).code, 409);
    const d = await call('POST', '/api/ws/delete', { path: 'sub/m.txt' });
    assert.equal(d.code, 200); await assert.rejects(fs.access(path.join(proj, 'sub', 'm.txt')));
    assert.equal(await fs.readFile(path.join(proj, d.obj.trash), 'utf8'), 'q');
    assert.ok(!(await call('GET', '/api/ws/tree')).obj.entries.some(e => e.path.startsWith('.codelab-trash')), 'корзина не видна в дереве');
    assert.equal((await call('POST', '/api/ws/delete', { path: '' })).code, 400);
  });
} finally { await fs.rm(tmp, { recursive: true, force: true }); }
console.log(`workspace: ${n} групп проверок пройдено`);
