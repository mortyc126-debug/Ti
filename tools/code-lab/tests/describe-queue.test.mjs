import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLibraryStore } from '../lib/library-store.mjs';
import { createDescriptionQueue } from '../lib/describe-queue.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'describe-queue-'));
try {
  const root = path.join(tmp, 'library');
  await fs.mkdir(path.join(root, 'js'), { recursive: true });
  await fs.writeFile(path.join(root, 'js', 'needs.js'), 'const total = items.reduce((a, b) => a + b, 0);\n');
  await fs.writeFile(path.join(root, 'js', 'needs.js.meta.json'), JSON.stringify({ schema: 1, id: 'needs', lang: 'js', title: 'needs', group: 'JS / Массивы', desc: '', tags: [], aliases: [], source: {}, status: 'needs_description' }));
  await fs.writeFile(path.join(root, 'js', 'manual.js'), 'console.log("hello")\n');
  await fs.writeFile(path.join(root, 'js', 'manual.js.meta.json'), JSON.stringify({ schema: 1, id: 'manual', lang: 'js', title: 'Моё название', group: 'Мой раздел', desc: 'Ручное описание', tags: ['мой тег'], aliases: ['мой синоним'], source: { title: 'manual', desc: 'manual', tags: 'manual', aliases: 'manual' }, status: 'described' }));
  const store = createLibraryStore({ root });
  await store.init();
  let calls = 0;
  const fakeFetch = async (_url, opts) => {
    calls++;
    assert.match(opts.headers.Authorization, /Bearer test-key/);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ title: 'Сумма массива', desc: 'Считает сумму значений массива.', tags: ['массивы', 'reduce'], aliases: ['сумма элементов'] }) } }] }) };
  };
  const queue = createDescriptionQueue({ store, statePath: path.join(tmp, 'jobs.json'), apiKey: 'test-key', fetchImpl: fakeFetch });
  await queue.init();
  const started = await queue.start();
  assert.equal(started.added, 1, 'по умолчанию ставится только кусок без описания');
  for (let i = 0; i < 100; i++) {
    const status = await queue.get();
    if (status.completed === 1 || status.failed) break;
    await new Promise(r => setTimeout(r, 10));
  }
  const result = await queue.get();
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.equal(calls, 1, 'один поток — один одновременный запрос');
  const described = await store.get('needs');
  assert.equal(described.title, 'Сумма массива');
  assert.equal(described.desc, 'Считает сумму значений массива.');
  assert.deepEqual(described.tags, ['массивы', 'reduce']);
  assert.deepEqual(described.aliases, ['сумма элементов']);
  assert.equal(described.status, 'described');
  const manual = await store.get('manual');
  await store.applyDescription('manual', { title: 'ИИ название', desc: 'ИИ описание', tags: ['ИИ'], aliases: ['ИИ синоним'] });
  const after = await store.get('manual');
  assert.equal(after.title, manual.title);
  assert.equal(after.desc, manual.desc);
  assert.deepEqual(after.tags, manual.tags);
  assert.deepEqual(after.aliases, manual.aliases);
  const disk = JSON.parse(await fs.readFile(path.join(tmp, 'jobs.json'), 'utf8'));
  assert.equal(disk.jobs[0].status, 'completed', 'состояние очереди сохраняется на диск');
  console.log('describe-queue: очередь, сохранение прогресса и защита manual проверены');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
