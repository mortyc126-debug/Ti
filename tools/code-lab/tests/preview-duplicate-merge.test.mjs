import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-merge-preview-'));
try {
  const library = path.join(tmp, 'library');
  await fs.mkdir(path.join(library, 'js'), { recursive: true });
  const code = 'const value = 1;\n';
  const hash = crypto.createHash('sha256').update(code.trim()).digest('hex');
  const first = { id: 'legacy-piece-mvr123abc', title: 'Коротко', desc: 'Коротко.', tags: ['старый-тег'], aliases: ['старый-вариант'], component: { provides: ['a'] }, source: { desc: 'imported' }, wordNotes: [{ line: 0, col: 6, text: 'value', kind: 'name', note: 'Значение.', source: 'custom' }, { line: 0, col: 0, text: 'const', kind: 'concept', note: 'Понятие.', source: '' }] };
  const second = { id: 'canonical-piece', title: 'Пример', desc: 'Подробное описание конструкции.', tags: ['канонический-тег'], aliases: ['пример'], component: null, source: { desc: 'manual' }, wordNotes: [{ line: 0, col: 6, text: 'value', kind: 'name', note: 'Значение.', source: 'dict' }], extraField: { keep: true } };
  await fs.writeFile(path.join(library, 'js', 'legacy-piece-mvr123abc.js'), code);
  await fs.writeFile(path.join(library, 'js', 'legacy-piece-mvr123abc.js.meta.json'), JSON.stringify(first));
  await fs.writeFile(path.join(library, 'js', 'canonical-piece.js'), code);
  await fs.writeFile(path.join(library, 'js', 'canonical-piece.js.meta.json'), JSON.stringify(second));

  const conflictCode = 'function run() { return 2; }\\n';
  const conflictHash = crypto.createHash('sha256').update(conflictCode.trim()).digest('hex');
  const conflictLegacy = { id: 'legacy-conflict-mvr123xyz', desc: 'Подробное описание со старой стороны.', source: { desc: 'imported' }, component: { provides: ['first'] } };
  const conflictCanonical = { id: 'canonical-conflict', desc: 'Коротко.', source: { desc: 'manual' }, component: { provides: ['second'] } };
  await fs.writeFile(path.join(library, 'js', 'legacy-conflict-mvr123xyz.js'), conflictCode);
  await fs.writeFile(path.join(library, 'js', 'legacy-conflict-mvr123xyz.js.meta.json'), JSON.stringify(conflictLegacy));
  await fs.writeFile(path.join(library, 'js', 'canonical-conflict.js'), conflictCode);
  await fs.writeFile(path.join(library, 'js', 'canonical-conflict.js.meta.json'), JSON.stringify(conflictCanonical));

  const manifestPath = path.join(tmp, 'manifest.json'), outputPath = path.join(tmp, 'preview.json');
  const manifest = { pairs: [
    { pair: 1, codeIdentical: true, codeHash: hash, canonical: { file: 'js/canonical-piece.js', id: 'canonical-piece' }, legacyIds: [{ id: 'legacy-piece-mvr123abc', redirectTo: 'canonical-piece' }], files: [
      { file: 'js/legacy-piece-mvr123abc.js', id: first.id }, { file: 'js/canonical-piece.js', id: second.id }
    ], notes: { anchorConflicts: [] }, urls: { union: [] } },
    { pair: 2, codeIdentical: true, codeHash: conflictHash, canonical: { file: 'js/canonical-conflict.js', id: 'canonical-conflict' }, legacyIds: [{ id: conflictLegacy.id, redirectTo: conflictCanonical.id }], files: [
      { file: 'js/legacy-conflict-mvr123xyz.js', id: conflictLegacy.id }, { file: 'js/canonical-conflict.js', id: conflictCanonical.id }
    ], notes: { anchorConflicts: [] }, urls: { union: [] } }
  ] };
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const scriptPath = fileURLToPath(new URL('../scripts/preview-duplicate-merge.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [scriptPath, library, manifestPath, outputPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const preview = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  const pair = preview.pairs[0];
  assert.equal(preview.summary.verifiedCodePairs, 2);
  assert.equal(pair.candidatePassport.id, 'canonical-piece');
  assert.equal(pair.candidatePassport.desc, 'Подробное описание конструкции.');
  assert.deepEqual(pair.candidatePassport.component, { provides: ['a'] });
  assert.deepEqual(pair.candidatePassport.source, { desc: 'manual' });
  assert.deepEqual(pair.candidatePassport.tags, ['канонический-тег', 'старый-тег']);
  assert.deepEqual(pair.candidatePassport.aliases, ['пример', 'старый-вариант']);
  assert.equal(pair.review.conceptNotes.length, 1);
  assert.equal(pair.candidatePassport.wordNotes.filter(note => note.kind === 'concept').length, 1);
  assert.equal(pair.candidatePassport.wordNotes.length, 3);
  assert.match(pair.review.conceptNoteHandling, /moved into candidate wordNotes\/orphanNotes/);
  assert.match(pair.review.noteConflictHandling, /custom notes last/);
  assert.deepEqual(pair.review.componentMergeProposal.values.map(item => item.value), [null, { provides: ['a'] }]);
  assert.deepEqual(pair.review.componentMergeProposal.nonConflicting, { provides: ['a'] });
  assert.deepEqual(pair.review.componentMergeProposal.conflicts, []);
  assert.equal(pair.review.componentMergeProposal.complete, true);
  assert.deepEqual(pair.review.provenanceMergeProposal.nonConflicting, { desc: 'manual' });
  assert.deepEqual(pair.review.provenanceMergeProposal.conflicts, []);
  assert.equal(pair.review.provenanceMergeProposal.complete, true);
  assert.equal(pair.review.provenanceMergeProposal.resolvedFields[0].selectedFile, 'js/canonical-piece.js');
  assert.equal(pair.review.provenanceMergeProposal.resolvedFields[0].selectedValue, 'manual');
  assert.deepEqual(pair.review.provenanceMergeProposal.resolvedFields[0].originalValues, [
    { file: 'js/canonical-piece.js', value: 'manual' },
    { file: 'js/legacy-piece-mvr123abc.js', value: 'imported' }
  ]);
  assert.equal(preview.summary.conceptNotesMovedIntoCandidatePassport, 0);
  assert.equal(preview.summary.componentDataPreservedInSourcePassports, 3);
  assert.equal(preview.summary.provenanceSourcePassportsPreserved, 4);
  assert.equal(preview.summary.componentFieldConflicts, 1);
  assert.equal(preview.summary.provenanceFieldConflicts, 0);
  assert.equal(preview.summary.provenanceOriginalDescConflicts, 2);
  assert.equal(preview.summary.descSourceProvenanceResolvedPairs, 2);
  assert.equal(preview.summary.componentMergeCompletePairs, 1);
  assert.equal(preview.summary.provenanceMergeCompletePairs, 2);
  assert.equal(preview.pairs[1].review.descSourceFile, 'js/legacy-conflict-mvr123xyz.js');
  assert.equal(preview.pairs[1].review.provenanceMergeProposal.nonConflicting.desc, 'imported');
  assert.equal(preview.pairs[1].review.provenanceMergeProposal.resolvedFields[0].selectedValue, 'imported');
  const componentConflict = preview.pairs[1].review.componentMergeProposal;
  assert.equal(componentConflict.complete, false);
  assert.deepEqual(componentConflict.nonConflicting, {});
  assert.deepEqual(componentConflict.conflicts, [{
    key: 'provides',
    values: [
      { file: 'js/canonical-conflict.js', value: ['second'] },
      { file: 'js/legacy-conflict-mvr123xyz.js', value: ['first'] }
    ]
  }]);
  assert.equal(preview.summary.componentFieldConflicts, 1);
  assert.equal(preview.summary.componentMergeCompletePairs, 1);
  assert.equal(pair.review.sourcePassports.length, 2);
  assert.equal(pair.review.sourcePassports.find(x => x.id === 'canonical-piece').passport.extraField.keep, true);
  assert.deepEqual(pair.review.provenanceMergeProposal.fields, [{
    key: 'desc',
    values: [
      { file: 'js/canonical-piece.js', value: 'manual' },
      { file: 'js/legacy-piece-mvr123abc.js', value: 'imported' }
    ]
  }]);
  assert.equal(pair.review.componentSources.find(x => x.component)?.file, 'js/legacy-piece-mvr123abc.js');
  assert.equal(pair.review.importable, true);
  assert.deepEqual(pair.review.unresolvedFieldConflicts, []);
  assert.ok(pair.review.fieldConflicts.some(field => field.field === 'extraField'));
  assert.ok(pair.review.fieldConflicts.some(field => field.field === 'wordNotes'));
  assert.equal(preview.summary.importablePairs, 1);
  assert.equal(preview.summary.conceptNotesMovedIntoCandidatePassport, 1);
  assert.equal(preview.pairs[1].review.importable, false);
  await fs.writeFile(path.join(library, 'js', 'canonical-piece.js'), 'const changed = 2;\n');
  const changedRun = spawnSync(process.execPath, [scriptPath, library, manifestPath, outputPath], { encoding: 'utf8' });
  assert.notEqual(changedRun.status, 0);
  assert.match(changedRun.stderr + changedRun.stdout, /Код изменился после аудита/);
  console.log('preview-duplicate-merge: conflict-safe merge checks passed');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
