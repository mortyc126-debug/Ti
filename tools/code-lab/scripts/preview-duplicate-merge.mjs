// Review-only dry run for exact-code duplicate consolidation.
// Reads source files and passports, writes one preview report outside library/.
// It never deletes, moves or edits library files.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const libraryRoot = path.resolve(process.argv[2] || 'tools/code-lab/library');
const manifestPath = path.resolve(process.argv[3] || 'duplicate-merge-manifest.json');
const outputPath = path.resolve(process.argv[4] || 'duplicate-merge-preview.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
if (!Array.isArray(manifest.pairs)) throw new Error('В манифесте нет списка пар');
const root = path.resolve(libraryRoot);
const output = path.resolve(outputPath);
const rootStat = await fs.lstat(root);
if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Корень библиотеки должен быть обычной папкой');
if (output === root || output.startsWith(root + path.sep)) throw new Error('Файл отчёта должен находиться вне библиотеки');
const outputStat = await fs.lstat(output).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
if (outputStat && (outputStat.isSymbolicLink() || !outputStat.isFile())) throw new Error('Файл отчёта должен быть обычным файлом');
const normalizeCode = value => String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
const hashCode = value => crypto.createHash('sha256').update(normalizeCode(value)).digest('hex');
const noteKey = note => JSON.stringify([note.line ?? null, note.col ?? null, note.text ?? '', note.kind ?? '', note.note ?? '', note.source ?? '']);
const uniqueNotes = notes => {
  const seen = new Set(), out = [];
  for (const note of notes) {
    const key = noteKey(note);
    if (!seen.has(key)) { seen.add(key); out.push(note); }
  }
  return out;
};
const uniqueList = values => {
  const seen = new Set(), out = [];
  for (const value of values.flatMap(x => Array.isArray(x) ? x : [x])) {
    if (value == null || value === '') continue;
    const key = String(value).trim().toLowerCase().replace(/ё/g, 'е');
    if (key && !seen.has(key)) { seen.add(key); out.push(value); }
  }
  return out;
};
const objectMergeProposal = sources => {
  const keys = [...new Set(sources.flatMap(source =>
    source.value && typeof source.value === 'object' && !Array.isArray(source.value)
      ? Object.keys(source.value) : []
  ))].sort();
  const nonConflicting = {};
  const conflicts = [];
  for (const key of keys) {
    const values = sources
      .filter(source => source.value && typeof source.value === 'object' &&
        !Array.isArray(source.value) && Object.prototype.hasOwnProperty.call(source.value, key))
      .map(source => ({ file: source.file, value: source.value[key] }));
    const distinct = new Map(values.map(item => [JSON.stringify(item.value), item.value]));
    if (distinct.size === 1) nonConflicting[key] = values[0].value;
    else conflicts.push({ key, values });
  }
  return { nonConflicting, conflicts, complete: conflicts.length === 0 };
};
async function readSafe(relative) {
  const clean = String(relative || '').replace(/\\/g, '/');
  if (!clean || clean.startsWith('/') || /^[a-z]:/i.test(clean) || clean.split('/').some(part => part === '..' || part === '')) {
    throw new Error('Небезопасный относительный путь: ' + relative);
  }
  let current = root;
  const parts = clean.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Символическая ссылка в исходной библиотеке: ' + clean);
    if (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) throw new Error('Неверный тип пути в исходной библиотеке: ' + clean);
  }
  return fs.readFile(current, 'utf8');
}

const previews = [];
for (const pair of manifest.pairs) {
  if (!pair.codeIdentical || !pair.canonical || !Array.isArray(pair.files) || pair.files.length !== 2) {
    throw new Error('Пара ' + pair.pair + ' не прошла предварительные условия манифеста');
  }
  const sources = [];
  for (const item of pair.files) {
    const code = await readSafe(item.file);
    const passportText = await readSafe(item.file + '.meta.json');
    const passport = JSON.parse(passportText);
    const actualHash = hashCode(code);
    if (actualHash !== pair.codeHash) throw new Error('Код изменился после аудита: ' + item.file);
    if (String(passport.id || '') !== item.id) throw new Error('ID паспорта не совпадает с манифестом: ' + item.file);
    sources.push({ file: item.file, id: item.id, codeHash: actualHash, code, passport });
  }
  const canonical = sources.find(source => source.id === pair.canonical.id && source.file === pair.canonical.file);
  if (!canonical) throw new Error('Канонический источник не найден для пары ' + pair.pair);
  const secondary = sources.find(source => source !== canonical);
  const orderedSources = [canonical, secondary];
  const descSource = [...orderedSources].sort((a, b) => String(b.passport.desc || '').length - String(a.passport.desc || '').length)[0];
  const allWordNotes = orderedSources.flatMap(source => (source.passport.wordNotes || []).filter(note => note && note.kind !== 'concept').map(note => ({ ...note, _sourceFile: source.file })));
  const allOrphanNotes = orderedSources.flatMap(source => (source.passport.orphanNotes || []).filter(note => note && note.kind !== 'concept').map(note => ({ ...note, _sourceFile: source.file })));
  const conceptNotes = orderedSources.flatMap(source => [
    ...(source.passport.wordNotes || []).filter(note => note && note.kind === 'concept').map(note => ({ ...note, sourceFile: source.file, collection: 'wordNotes' })),
    ...(source.passport.orphanNotes || []).filter(note => note && note.kind === 'concept').map(note => ({ ...note, sourceFile: source.file, collection: 'orphanNotes' }))
  ]);
  const fields = [...new Set([...Object.keys(canonical.passport), ...Object.keys(secondary.passport)])].filter(field => !['id', 'file', 'schema', 'lang'].includes(field)).sort();
  const fieldConflicts = fields.filter(field => JSON.stringify(orderedSources[0].passport[field] ?? null) !== JSON.stringify(orderedSources[1].passport[field] ?? null)).map(field => ({
    field,
    values: orderedSources.map(source => ({ file: source.file, value: source.passport[field] ?? null }))
  }));
  // Keep provenance out of the candidate passport until the real source schema is
  // explicitly reconciled. This proposal is lossless and review-only: every
  // original key/value remains paired with the passport it came from.
  const provenanceKeys = [...new Set(orderedSources.flatMap(source =>
    Object.keys(source.passport.source && typeof source.passport.source === 'object' ? source.passport.source : {})
  ))].sort();
  const provenanceSources = orderedSources.map(source => ({ file: source.file, value: source.passport.source ?? null }));
  const selectedDescProvenance = descSource.passport.source?.desc ?? null;
  // source.desc describes the provenance of passport.desc, not an independent
  // source choice. Keep every original value below, but align the merge proposal
  // with the exact passport from which the selected description was taken.
  const resolvedProvenanceSources = orderedSources.map(source => ({
    file: source.file,
    value: { ...(source.passport.source && typeof source.passport.source === 'object' ? source.passport.source : {}), desc: selectedDescProvenance }
  }));
  const originalProvenanceProposal = objectMergeProposal(provenanceSources);
  const provenanceMergeProposal = {
    mode: 'source.desc follows descSourceFile; all original values remain listed for review',
    ...objectMergeProposal(resolvedProvenanceSources),
    fields: provenanceKeys.map(key => ({
      key,
      values: orderedSources
        .filter(source => source.passport.source && typeof source.passport.source === 'object' &&
          Object.prototype.hasOwnProperty.call(source.passport.source, key))
        .map(source => ({ file: source.file, value: source.passport.source[key] }))
    })),
    resolvedFields: [{
      key: 'desc',
      selectedFile: descSource.file,
      selectedValue: selectedDescProvenance,
      rule: 'the provenance of desc follows the passport selected for desc',
      originalValues: orderedSources.map(source => ({
        file: source.file,
        value: source.passport.source?.desc ?? null
      })),
      hadConflict: originalProvenanceProposal.conflicts.some(conflict => conflict.key === 'desc')
    }]
  };
  const componentSources = orderedSources.map(source => ({ file: source.file, value: source.passport.component ?? null }));
  const componentMergeProposal = {
    mode: 'merge only identical or one-sided component fields; retain conflicts without choosing a winner',
    ...objectMergeProposal(componentSources),
    values: componentSources
  };
  const candidatePassport = {
    ...canonical.passport,
    id: canonical.id,
    file: path.posix.basename(canonical.file),
    title: canonical.passport.title || secondary.passport.title || canonical.id,
    group: canonical.passport.group || secondary.passport.group || '',
    desc: descSource.passport.desc || '',
    descAt: descSource.passport.descAt ?? canonical.passport.descAt ?? secondary.passport.descAt,
    output: canonical.passport.output || secondary.passport.output || '',
    labels: { ...(secondary.passport.labels || {}), ...(canonical.passport.labels || {}) },
    externalLinks: canonical.passport.externalLinks ?? secondary.passport.externalLinks ?? null,
    tags: uniqueList(orderedSources.map(source => source.passport.tags || [])),
    aliases: uniqueList(orderedSources.map(source => source.passport.aliases || [])),
    status: orderedSources.some(source => source.passport.status === 'described') ? 'described' : (canonical.passport.status || secondary.passport.status || 'needs_description'),
    // Concepts and component/provenance data stay out of the provisional passport:
    // their original collection/schema must be reviewed before any import.
    wordNotes: uniqueNotes(allWordNotes).map(({ _sourceFile, ...note }) => note),
    orphanNotes: uniqueNotes(allOrphanNotes).map(({ _sourceFile, ...note }) => note),
    _mergePreviewOnly: true
  };
  delete candidatePassport.component;
  delete candidatePassport.source;
  if (!Object.keys(candidatePassport.labels || {}).length) delete candidatePassport.labels;
  if (candidatePassport.externalLinks == null) delete candidatePassport.externalLinks;
  previews.push({
    pair: pair.pair,
    code: { identical: true, hash: pair.codeHash, sourceFiles: orderedSources.map(source => source.file) },
    canonical: pair.canonical,
    legacyIds: pair.legacyIds,
    candidatePassport,
    review: {
      importable: false,
      reason: 'Временный кандидат; component, provenance и concept-записи требуют отдельного решения',
      fieldConflicts,
      descSourceFile: descSource.file,
      componentSources: componentSources.map(source => ({ file: source.file, component: source.value })),
      provenanceSources: provenanceSources.map(source => ({ file: source.file, source: source.value })),
      provenanceMergeProposal,
      componentMergeProposal,
      sourcePassports: orderedSources.map(source => ({ file: source.file, id: source.id, passport: source.passport })),
      conceptNotes,
      conceptNoteHandling: 'not moved into candidate wordNotes; original collection and record retained in sourcePassports',
      noteAnchorConflicts: pair.notes.anchorConflicts,
      noteConflictHandling: 'all distinct note records retained; identical explanation with differing kind/source is metadata-only and no winner is selected',
      urls: pair.urls
    }
  });
}
const summary = {
  pairCount: previews.length,
  verifiedCodePairs: previews.filter(item => item.code.identical).length,
  sourcePassportsPreserved: previews.reduce((n, item) => n + item.review.sourcePassports.length, 0),
  pairsWithFieldConflicts: previews.filter(item => item.review.fieldConflicts.length).length,
  pairsWithComponentDataOnBothSides: previews.filter(item => item.review.componentSources.every(x => x.component != null)).length,
  conceptNotesPreservedSeparately: previews.reduce((n, item) => n + item.review.conceptNotes.length, 0),
  conceptNotesMovedIntoCandidatePassport: 0,
  noteAnchorConflicts: previews.reduce((n, item) => n + item.review.noteAnchorConflicts.length, 0),
  differentExplanationConflicts: previews.reduce((n, item) => n + item.review.noteAnchorConflicts.filter(note => (note.explanations || []).length > 1).length, 0),
  metadataOnlyNoteConflicts: previews.reduce((n, item) => n + item.review.noteAnchorConflicts.filter(note => (note.explanations || []).length === 1 && ((note.kinds || []).length > 1 || (note.sources || []).length > 1)).length, 0),
  componentDataPreservedInSourcePassports: previews.reduce((n, item) => n + item.review.componentSources.filter(x => x.component != null).length, 0),
  provenanceSourcePassportsPreserved: previews.reduce((n, item) => n + item.review.provenanceSources.filter(x => x.source != null).length, 0),
  componentFieldConflicts: previews.reduce((n, item) => n + item.review.componentMergeProposal.conflicts.length, 0),
  provenanceFieldConflicts: previews.reduce((n, item) => n + item.review.provenanceMergeProposal.conflicts.length, 0),
  provenanceOriginalDescConflicts: previews.reduce((n, item) => n + item.review.provenanceMergeProposal.resolvedFields.filter(field => field.hadConflict).length, 0),
  descSourceProvenanceResolvedPairs: previews.filter(item => item.review.provenanceMergeProposal.resolvedFields.some(field => field.key === 'desc')).length,
  componentMergeCompletePairs: previews.filter(item => item.review.componentMergeProposal.complete).length,
  provenanceMergeCompletePairs: previews.filter(item => item.review.provenanceMergeProposal.complete).length,
  importablePairs: 0
};
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode: 'dry-run only; library files were not modified',
  sourceManifest: path.basename(manifestPath),
  libraryRoot: path.relative(process.cwd(), root),
  summary,
  pairs: previews
};
await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ output, summary }, null, 2));
