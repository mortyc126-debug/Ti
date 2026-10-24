// Тесты управляемой установки (без интернета: реестр подменён). Запуск:  node --test tools/code-lab/lib/vendor.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createVendor, MODE_MAP, VendorError } from './vendor.mjs';

// ---- собираем настоящий tar.gz в памяти ----
function tarEntry(name, data, type = '0') {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(body.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
  h.write('        ', 148); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
const makeTgz = entries => zlib.gzipSync(Buffer.concat([...entries.map(e => tarEntry(...e)), Buffer.alloc(1024)]));
const goodEntries = (ver, extra = []) => [
  ['package/package.json', JSON.stringify({ name: 'codemirror', version: ver })],
  ['package/lib/codemirror.js', 'window.CodeMirror={version:"' + ver + '"};'],
  ['package/lib/codemirror.css', '.CodeMirror{}'],
  ['package/addon/runmode/runmode.js', '//runmode'],
  ['package/mode/javascript/javascript.js', '//js'],
  ['package/src/ignored.js', '//не берём'],
  ['package/LICENSE', 'MIT'],
  ...extra,
];

// ---- подмена реестра ----
function registry({ versions = { '5.65.99': { age: 100 } }, tarballs = {}, failNet = false, tarballUrlHost = 'registry.npmjs.org' } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push(String(url));
    if (failNet) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    const u = new URL(url);
    const json = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/codemirror') {
      const abbr = init.headers && /install-v1/.test(init.headers.Accept || '');
      if (abbr) return json({ name: 'codemirror', 'dist-tags': { latest: '6.0.2', version5: Object.keys(versions).at(-1) }, versions: Object.fromEntries(Object.keys(versions).concat(['6.0.2']).map(v => [v, { name: 'codemirror', version: v, dist: { fileCount: 5, unpackedSize: 99 } }])) });
      return json({ time: Object.fromEntries(Object.entries(versions).map(([v, o]) => [v, new Date(Date.now() - o.age * 86400000).toISOString()])) });
    }
    const mv = /^\/codemirror\/(\d+\.\d+\.\d+)$/.exec(u.pathname);
    if (mv) {
      const tgz = tarballs[mv[1]] || makeTgz(goodEntries(mv[1]));
      return json({ name: 'codemirror', version: mv[1], dist: { tarball: `https://${tarballUrlHost}/codemirror/-/codemirror-${mv[1]}.tgz`, integrity: 'sha512-' + crypto.createHash('sha512').update(tgz).digest('base64') } });
    }
    const mt = /^\/codemirror\/-\/codemirror-(\d+\.\d+\.\d+)\.tgz$/.exec(u.pathname);
    if (mt) { const tgz = tarballs[mt[1] + ':served'] || tarballs[mt[1]] || makeTgz(goodEntries(mt[1])); return new Response(tgz, { status: 200 }); }
    return new Response('nope', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

async function setup(reg) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vendor-test-'));
  const v = createVendor({ root, fetchImpl: reg });
  await v.init();
  return { root, v, dir: path.join(root, 'codemirror') };
}
const passTest = { ok: true, entries: 3, ms: 5 };

test('проверка: находит новую версию, без сети — понятная ошибка и ничего не ломается', async () => {
  const { v } = await setup(registry({ versions: { '5.65.98': { age: 400 }, '5.65.99': { age: 100 } } }));
  const r = await v.check();
  assert.equal(r.ok, true); assert.equal(r.latest, '5.65.99');
  assert.deepEqual(r.candidates.map(c => c.version), ['5.65.99']);   // для первой установки — только рекомендованная
  assert.equal(r.candidates[0].young, false);

  const off = await setup(registry({ failNet: true }));
  await assert.rejects(() => off.v.check(), e => e instanceof VendorError && e.code === 'NETWORK');
  const st = await off.v.status();
  assert.equal(st.lastCheck.ok, false); assert.equal(st.active, null);
});

test('установка: только нужные папки, версия не включается сама, шестая ветка отвергается', async () => {
  const { v, dir } = await setup(registry());
  const info = await v.install('5.65.99');
  assert.equal(info.version, '5.65.99');
  assert.ok(await fs.stat(path.join(dir, '5.65.99/lib/codemirror.js')));
  await assert.rejects(fs.stat(path.join(dir, '5.65.99/src/ignored.js')));   // src не копируется
  assert.equal((await v.status()).active, null);                              // не активна
  await assert.rejects(() => v.install('6.0.2'), e => e.code === 'BAD_VERSION');
  await assert.rejects(() => v.install('latest'), e => e.code === 'BAD_VERSION');
  await assert.rejects(() => v.install('5.65.99'), e => e.code === 'EXISTS');
});

test('подмена архива: контрольная сумма не совпала — ничего не остаётся на диске', async () => {
  const evil = makeTgz(goodEntries('5.65.99', [['package/addon/evil.js', 'steal()']]));
  const reg = registry({ tarballs: { '5.65.99:served': evil } });          // метаданные считают сумму от настоящего архива
  const { v, dir } = await setup(reg);
  await assert.rejects(() => v.install('5.65.99'), e => e.code === 'INTEGRITY');
  assert.deepEqual((await fs.readdir(dir)).filter(n => n !== 'manifest.json'), []);
});

test('архив с опасным путём или ссылкой: путь — отказ, ссылки — пропуск', async () => {
  for (const bad of ['package/../evil.js', '/etc/passwd', 'package/lib/..\\x.js']) {
    const tgz = makeTgz(goodEntries('5.65.99', [[bad, 'x']]));
    const { v, dir } = await setup(registry({ tarballs: { '5.65.99': tgz } }));
    await assert.rejects(() => v.install('5.65.99'), e => e.code === 'UNSAFE_PATH', bad);
    assert.deepEqual((await fs.readdir(dir)).filter(n => n !== 'manifest.json'), []);
  }
  const link = makeTgz(goodEntries('5.65.99', [['package/lib/link.js', '', '2']]));
  const { v, dir } = await setup(registry({ tarballs: { '5.65.99': link } }));
  await v.install('5.65.99');
  await assert.rejects(fs.stat(path.join(dir, '5.65.99/lib/link.js')));
});

test('адрес архива не с реестра npm — отказ', async () => {
  const { v } = await setup(registry({ tarballUrlHost: 'evil.example.com' }));
  await assert.rejects(() => v.install('5.65.99'), e => e.code === 'BAD_URL');
});

test('свежая версия: без подтверждения нельзя, с подтверждением можно', async () => {
  const { v } = await setup(registry({ versions: { '5.65.99': { age: 3 } } }));
  const r = await v.check();
  assert.equal(r.candidates[0].young, true);
  await assert.rejects(() => v.install('5.65.99'), e => e.code === 'YOUNG');
  const info = await v.install('5.65.99', { allowYoung: true });
  assert.equal(info.version, '5.65.99');
});

test('включение: нельзя без успешной проверки; откат и выключение; активную не удалить', async () => {
  const { v } = await setup(registry({ versions: { '5.65.98': { age: 400 }, '5.65.99': { age: 100 } } }));
  await v.install('5.65.98'); await v.install('5.65.99');
  await assert.rejects(() => v.activate('5.65.98'), e => e.code === 'NOT_TESTED');
  await v.recordTest('5.65.98', { ...passTest, cmVersion: '5.65.98' });
  await v.activate('5.65.98');
  await v.recordTest('5.65.99', { ok: true, cmVersion: '5.65.98' });                // версия редактора не та — проверка не засчитана
  await assert.rejects(() => v.activate('5.65.99'), e => e.code === 'NOT_TESTED');
  await v.recordTest('5.65.99', { ...passTest, cmVersion: '5.65.99' });
  await v.activate('5.65.99');
  assert.equal(v.activeInfo().version, '5.65.99');
  await assert.rejects(() => v.remove('5.65.99'), e => e.code === 'ACTIVE');
  await v.rollback();
  assert.equal(v.activeInfo().version, '5.65.98');
  await v.deactivate();
  assert.equal(v.activeInfo().version, null);
  await v.remove('5.65.99');
  assert.equal((await v.status()).installed.length, 1);
});

test('целостность: правка файла, лишний файл — включение запрещено', async () => {
  const { v, dir } = await setup(registry());
  await v.install('5.65.99');
  await v.recordTest('5.65.99', { ...passTest, cmVersion: '5.65.99' });
  assert.equal((await v.verify('5.65.99')).ok, true);
  await fs.appendFile(path.join(dir, '5.65.99/lib/codemirror.js'), '\n//подмена');
  const bad = await v.verify('5.65.99');
  assert.equal(bad.ok, false); assert.match(bad.problems[0], /изменён/);
  await assert.rejects(() => v.activate('5.65.99'), e => e.code === 'CORRUPT');
  await fs.writeFile(path.join(dir, '5.65.99/lib/codemirror.js'), 'window.CodeMirror={version:"5.65.99"};');
  await fs.writeFile(path.join(dir, '5.65.99/lib/extra.js'), 'x');
  assert.match((await v.verify('5.65.99')).problems.join(), /лишний файл/);
});

test('выдача файлов: только установленные версии, только lib/mode/addon…, только js/css, без выхода из папки', async () => {
  const { v, dir } = await setup(registry());
  await v.install('5.65.99');
  const ok = v.resolveFile('5.65.99', 'lib/codemirror.js');
  assert.equal(ok, path.join(dir, '5.65.99', 'lib', 'codemirror.js'));
  for (const bad of ['../manifest.json', 'lib/../../manifest.json', 'files.json', 'package.json', 'lib/codemirror.js\0', '/etc/passwd', 'lib\\codemirror.js', 'lib/']) assert.equal(v.resolveFile('5.65.99', bad), null, bad);
  assert.equal(v.resolveFile('5.65.1', 'lib/codemirror.js'), null);
  assert.equal(v.resolveFile('../x', 'lib/codemirror.js'), null);
});

test('карта режимов: у каждого языка есть режим и файлы; зависимости идут раньше', () => {
  for (const [lang, s] of Object.entries(MODE_MAP)) { assert.ok(s.mode && s.files.length, lang); }
  assert.ok(MODE_MAP.html.files.indexOf('xml') < MODE_MAP.html.files.indexOf('htmlmixed'));
  assert.ok(MODE_MAP.php.files.indexOf('htmlmixed') < MODE_MAP.php.files.indexOf('php'));
  assert.ok(MODE_MAP.php.files.indexOf('clike') < MODE_MAP.php.files.indexOf('php'));
});

test('перезапуск: состояние читается с диска, потерянные версии убираются', async () => {
  const { root, v, dir } = await setup(registry());
  await v.install('5.65.99');
  await v.recordTest('5.65.99', { ...passTest, cmVersion: '5.65.99' }); await v.activate('5.65.99');
  const v2 = createVendor({ root, fetchImpl: registry() }); await v2.init();
  assert.equal(v2.activeInfo().version, '5.65.99');
  await fs.rm(path.join(dir, '5.65.99'), { recursive: true });
  const v3 = createVendor({ root, fetchImpl: registry() }); await v3.init();
  assert.equal(v3.activeInfo().version, null);
  assert.equal((await v3.status()).installed.length, 0);
});
