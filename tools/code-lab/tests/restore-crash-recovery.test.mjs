import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recoverRestoreTransactions } from '../lib/restore-transaction.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-crash-recovery-'));
const moduleUrl = new URL('../lib/restore-transaction.mjs', import.meta.url).href;
const childSource = (fixture, stage) => `
  import { promises as fs } from 'node:fs';
  import path from 'node:path';
  import { prepareRestoreTransaction, markRestoreTransaction, syncRestoreFile, syncRestoreDirectory } from ${JSON.stringify(moduleUrl)};
  const f = ${JSON.stringify(fixture)};
  const root = f.root;
  const backupRoot = path.join(f.backupDir, f.id);
  const oldFile = path.join(root, 'old.txt');
  const newFile = path.join(root, 'new.txt');
  const deletedFile = path.join(root, 'deleted.txt');
  await fs.mkdir(path.join(backupRoot, 'files'), { recursive: true });
  const backups = new Map();
  for (const [target, name] of [[oldFile, 'old.txt'], [deletedFile, 'deleted.txt']]) {
    const backup = path.join(backupRoot, 'files', name);
    await fs.copyFile(target, backup);
    await syncRestoreFile(fs, backup);
    await syncRestoreDirectory(fs, path.dirname(backup));
    backups.set(target, backup);
  }
  const writes = [{ abs: oldFile }, { abs: newFile }];
  const deletions = [{ abs: deletedFile }];
  await prepareRestoreTransaction({ fs, backupRoot, root, rootName: 'library', writes, deletions, backups });
  await fs.writeFile(oldFile, 'new old file');
  await syncRestoreFile(fs, oldFile);
  await syncRestoreDirectory(fs, path.dirname(oldFile));
  if (${JSON.stringify(stage)} === 'after-first-write') process.exit(71);
  await fs.writeFile(newFile, 'new file');
  await syncRestoreFile(fs, newFile);
  await syncRestoreDirectory(fs, path.dirname(newFile));
  await fs.unlink(deletedFile);
  await syncRestoreDirectory(fs, path.dirname(deletedFile));
  if (${JSON.stringify(stage)} === 'after-all-writes') process.exit(72);
  await markRestoreTransaction({ fs, backupRoot, state: 'COMMITTED' });
  process.exit(0);
`;

async function runCrashCase(id, stage){
  const root = path.join(tmp, id, 'library');
  const backupDir = path.join(tmp, id, 'data', 'restore-backups');
  await fs.mkdir(root, { recursive: true });
  const oldFile = path.join(root, 'old.txt');
  const deletedFile = path.join(root, 'deleted.txt');
  await fs.writeFile(oldFile, 'original old file');
  await fs.writeFile(deletedFile, 'original deleted file');
  const fixture = { id, root, backupDir };
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childSource(fixture, stage)], { encoding: 'utf8' });
  if(stage === 'after-first-write') assert.equal(child.status, 71, child.stderr || child.stdout);
  else if(stage === 'after-all-writes') assert.equal(child.status, 72, child.stderr || child.stdout);
  else assert.equal(child.status, 0, child.stderr || child.stdout);

  const recovered = await recoverRestoreTransactions({ fs, backupDir, roots: { library: root } });
  if(stage === 'committed'){
    assert.deepEqual(recovered, []);
    assert.equal(await fs.readFile(oldFile, 'utf8'), 'new old file');
    assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'new file');
    await assert.rejects(fs.access(deletedFile), { code: 'ENOENT' });
  } else {
    assert.deepEqual(recovered, [id]);
    assert.equal(await fs.readFile(oldFile, 'utf8'), 'original old file');
    assert.equal(await fs.readFile(deletedFile, 'utf8'), 'original deleted file');
    await assert.rejects(fs.access(path.join(root, 'new.txt')), { code: 'ENOENT' });
  }
}

try {
  await runCrashCase('crash-after-first', 'after-first-write');
  await runCrashCase('crash-after-all', 'after-all-writes');
  await runCrashCase('already-committed', 'committed');
  const backupDir = path.join(tmp, 'crash-after-first', 'data', 'restore-backups');
  assert.deepEqual(await recoverRestoreTransactions({
    fs,
    backupDir,
    roots: { library: path.join(tmp, 'crash-after-first', 'library') }
  }), []);
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
console.log('restore-crash-recovery: 3 сценария аварийного завершения пройдены');
