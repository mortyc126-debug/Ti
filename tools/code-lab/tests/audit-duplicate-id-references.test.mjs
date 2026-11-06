import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-id-refs-'));
try {
  const root = path.join(tmp, 'tools', 'code-lab');
  await fs.mkdir(path.join(root, 'tasks'), { recursive: true });
  await fs.mkdir(path.join(root, 'recipes'), { recursive: true });
  await fs.writeFile(path.join(root, 'tasks', 'task.json'), JSON.stringify({ id: 'task-1', steps: [{ id: 'legacy-piece', kind: 'piece' }, { id: 'legacy-piece' }] }));
  await fs.writeFile(path.join(root, 'recipes', 'readme.md'), 'Ссылка: legacy-piece\n');
  const manifestPath = path.join(tmp, 'manifest.json');
  const outputPath = path.join(tmp, 'report.json');
  await fs.writeFile(manifestPath, JSON.stringify({ pairs: [{ legacyIds: [{ id: 'legacy-piece', redirectTo: 'canonical-piece' }, { id: 'unused-piece', redirectTo: 'canonical-unused' }] }] }));
  const scriptPath = fileURLToPath(new URL('../scripts/audit-duplicate-id-references.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [scriptPath, root, manifestPath, outputPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  assert.equal(report.legacyIdsTotal, 2);
  assert.equal(report.referencedLegacyIds, 1);
  assert.equal(report.referenceCount, 3);
  assert.deepEqual(report.unreferencedLegacyIds, ['unused-piece']);
  assert.equal(report.references.filter(x => x.file === 'tasks/task.json').length, 2);
  assert.equal(report.references.find(x => x.file === 'recipes/readme.md').count, 1);
  console.log('audit-duplicate-id-references: 7 checks passed');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
