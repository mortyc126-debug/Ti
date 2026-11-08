import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(ROOT, 'tools', 'code-lab', 'scripts', 'preview-duplicate-merge.mjs');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'code-lab-duplicate-preview-'));

try {
  const library = path.join(temporary, 'library');
  await fs.mkdir(library, { recursive: true });
  const code = 'export const answer = 42;\n';
  await fs.writeFile(path.join(library, 'alpha.js'), code);
  await fs.writeFile(path.join(library, 'alpha.js.meta.json'), JSON.stringify({
    id: 'alpha', title: 'Alpha', lang: 'js', desc: 'Первое описание'
  }));
  await fs.writeFile(path.join(library, 'alpha-copy.js'), code);
  await fs.writeFile(path.join(library, 'alpha-copy.js.meta.json'), JSON.stringify({
    id: 'alpha-mvabcdef', title: 'Alpha copy', lang: 'js', desc: 'Второе описание'
  }));

  const manifestPath = path.join(temporary, 'manifest.json');
  const outputPath = path.join(temporary, 'preview.json');
  const manifest = {
    schemaVersion: 1,
    pairs: [
      {
        pair: 1,
        codeIdentical: true,
        codeHash: null,
        canonical: { file: 'alpha.js', id: 'alpha' },
        legacyIds: [{ id: 'alpha-mvabcdef', file: 'alpha-copy.js', redirectTo: 'alpha' }],
        files: [
          { file: 'alpha.js', id: 'alpha' },
          { file: 'alpha-copy.js', id: 'alpha-mvabcdef' }
        ],
        notes: { anchorConflicts: [] },
        urls: { union: [] }
      },
      {
        pair: 2,
        codeIdentical: true,
        status: 'manual-canonical-choice-required',
        canonical: null,
        files: [
          { file: 'manual-a.js', id: 'manual-a' },
          { file: 'manual-b.js', id: 'manual-b' }
        ],
        notes: { anchorConflicts: [] },
        urls: { union: [] }
      },
      {
        pair: 3,
        codeIdentical: true,
        status: 'manual-review-required',
        canonical: null,
        files: [
          { file: 'group-a.js', id: 'group-a' },
          { file: 'group-b.js', id: 'group-b' },
          { file: 'group-c.js', id: 'group-c' }
        ],
        notes: { anchorConflicts: [] },
        urls: { union: [] }
      },
      {
        pair: 4,
        codeIdentical: false,
        canonical: { file: 'changed.js', id: 'changed' },
        files: [
          { file: 'changed.js', id: 'changed' },
          { file: 'changed-copy.js', id: 'changed-mvabcdef' }
        ],
        notes: { anchorConflicts: [] },
        urls: { union: [] }
      }
    ]
  };
  const crypto = await import('node:crypto');
  manifest.pairs[0].codeHash = crypto.createHash('sha256').update(code.trim()).digest('hex');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  execFileSync(process.execPath, [SCRIPT, library, manifestPath, outputPath], { encoding: 'utf8' });
  const preview = JSON.parse(await fs.readFile(outputPath, 'utf8'));

  assert.equal(preview.summary.pairCount, 1, 'eligible pair should still be previewed');
  assert.equal(preview.summary.skippedPairCount, 3, 'manual and unsupported groups should be counted, not fatal');
  assert.equal(preview.pairs[0].canonical.id, 'alpha');
  assert.deepEqual(preview.skippedPairs.map(item => item.pair), [2, 3, 4]);
  assert.match(preview.skippedPairs[0].reasons.join(' '), /ручного выбора/);
  assert.match(preview.skippedPairs[1].reasons.join(' '), /двух файлов/);
  assert.match(preview.skippedPairs[2].reasons.join(' '), /не подтверждён/);
  console.log('duplicate-merge-preview: eligible pairs previewed; manual groups reported without aborting');
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
