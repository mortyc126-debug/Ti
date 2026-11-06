import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-merge-manifest-'));
try {
  const reportPath = path.join(tmp, 'audit-library-report.json');
  const outputPath = path.join(tmp, 'manifest.json');
  const report = {
    generatedAt: '2026-11-06T15:00:00.000Z',
    duplicateReview: [{ count: 2, files: [
      { file: 'js/пример-mvr123abc.js', id: 'пример-mvr123abc', rawHash: 'same', codeUrls: ['https://example.com/a'], metaUrls: [], metaSummary: {
        desc: 'Коротко.', tags: [], aliases: [], component: { provides: ['x'] }, wordNotes: [
          { line: 0, col: 0, text: 'const', kind: 'kw', note: 'Объявляет переменную.', source: 'dict' },
          { line: 0, col: 0, text: 'const', kind: 'concept', note: 'Ключевое понятие.', source: '' }
        ], orphanNotes: []
      } },
      { file: 'js/пример.js', id: 'пример', rawHash: 'same', codeUrls: [], metaUrls: [], metaSummary: {
        desc: 'Подробное описание конструкции.', tags: ['основа'], aliases: ['пример'], component: null, wordNotes: [
          { line: 0, col: 0, text: 'const', kind: 'name', note: 'Объявляет переменную.', source: undefined }
        ], orphanNotes: []
      } }
    ] }]
  };
  await fs.writeFile(reportPath, JSON.stringify(report));
  const scriptPath = fileURLToPath(new URL('../scripts/build-duplicate-merge-manifest.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [scriptPath, reportPath, outputPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const manifest = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  const pair = manifest.pairs[0];
  assert.equal(manifest.summary.pairCount, 1);
  assert.equal(manifest.summary.identicalCodePairs, 1);
  assert.equal(pair.canonical.id, 'пример');
  assert.equal(pair.legacyIds[0].redirectTo, 'пример');
  assert.equal(pair.proposedFieldMerge.desc.value, 'Подробное описание конструкции.');
  assert.deepEqual(pair.proposedFieldMerge.tags, ['основа']);
  assert.equal(pair.notes.anchorConflicts.length, 1);
  assert.deepEqual(pair.notes.anchorConflicts[0].kinds.sort(), ['kw', 'name']);
  assert.ok(pair.notes.anchorConflicts[0].sources.includes(''));
  assert.equal(pair.notes.conceptNotes.length, 1);
  assert.equal(pair.urls.union[0], 'https://example.com/a');
  console.log('duplicate-merge-manifest: 12 checks passed');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
