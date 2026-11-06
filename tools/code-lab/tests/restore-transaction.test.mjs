import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyFileAtomic, rollbackRestore } from '../lib/restore-transaction.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-transaction-'));
try {
  await (async () => {
    const dir = path.join(tmp, 'pair');
    await fs.mkdir(dir, { recursive: true });
    const code = path.join(dir, 'piece.js');
    const meta = path.join(dir, 'piece.js.meta.json');
    const codeBackup = path.join(tmp, 'code.backup');
    const metaBackup = path.join(tmp, 'meta.backup');
    await fs.writeFile(code, 'old code');
    await fs.writeFile(meta, 'old passport');
    await fs.writeFile(codeBackup, 'old code');
    await fs.writeFile(metaBackup, 'old passport');

    // Имитируем: паспорт уже записан, запись кода успела частично изменить файл и упала.
    await fs.writeFile(meta, 'new passport');
    await fs.writeFile(code, 'partially written code');
    const written = [{ abs: meta }, { abs: code }];
    const errors = await rollbackRestore({
      fs,
      written,
      backups: new Map([[meta, metaBackup], [code, codeBackup]])
    });

    assert.deepEqual(errors, []);
    assert.equal(await fs.readFile(code, 'utf8'), 'old code');
    assert.equal(await fs.readFile(meta, 'utf8'), 'old passport');
  })();

  await (async () => {
    const created = path.join(tmp, 'new-piece.js');
    const partial = { abs: created };
    await fs.writeFile(created, 'partial');
    const errors = await rollbackRestore({ fs, written: [partial] });
    assert.deepEqual(errors, []);
    await assert.rejects(fs.access(created), { code: 'ENOENT' });
  })();

  await (async () => {
    const target = path.join(tmp, 'atomic-target.txt');
    const source = path.join(tmp, 'atomic-source.txt');
    await fs.writeFile(target, 'keep this');
    await fs.writeFile(source, 'replacement');
    const failingFs = {
      ...fs,
      mkdir: fs.mkdir.bind(fs),
      copyFile: async (from, to) => {
        if(to.includes('.restore-')) {
          await fs.writeFile(to, 'incomplete temp');
          throw new Error('simulated copy failure');
        }
        return fs.copyFile(from, to);
      },
      rename: fs.rename.bind(fs),
      unlink: fs.unlink.bind(fs)
    };
    await assert.rejects(copyFileAtomic(source, target, failingFs), /simulated copy failure/);
    assert.equal(await fs.readFile(target, 'utf8'), 'keep this');
    assert.deepEqual((await fs.readdir(tmp)).filter(name => name.startsWith('.restore-')), []);
  })();

  await (async () => {
    const target = path.join(tmp, 'rollback-target.txt');
    const backup = path.join(tmp, 'rollback-backup.txt');
    await fs.writeFile(target, 'damaged');
    await fs.writeFile(backup, 'original');
    const failingFs = {
      ...fs,
      mkdir: fs.mkdir.bind(fs),
      copyFile: async (from, to) => {
        if(from === backup) throw new Error('simulated rollback failure');
        return fs.copyFile(from, to);
      },
      rename: fs.rename.bind(fs),
      unlink: fs.unlink.bind(fs)
    };
    const errors = await rollbackRestore({
      fs: failingFs,
      written: [{ abs: target }],
      backups: new Map([[target, backup]])
    });
    assert.deepEqual(errors, ['simulated rollback failure']);
    assert.equal(await fs.readFile(target, 'utf8'), 'damaged');
  })();
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
console.log('restore-transaction: 4 сценария пройдены');
