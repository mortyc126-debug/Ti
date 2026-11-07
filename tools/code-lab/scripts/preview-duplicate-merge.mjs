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
  const candidateConceptNotes = uniqueNotes(conceptNotes.map(({ sourceFile, collection, ...note }) => note));
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
  const provenanceMergeProposal = {
    mode: 'preserve-all-values; manual schema reconciliation required',
    fields: provenanceKeys.map(key => ({
      key,
      values: orderedSources
        .filter(source => source.passport.source && typeof source.passport.source === 'object' &&
          Object.prototype.hasOwnProperty.call(source.passport.source, key))
        .map(source => ({ file: source.file, value: source.passport.source[key] }))
    }))
  };
  const candidatePassport = {
    ...canonical.passport,
    id: canonical.id,
    file: path.posix.basename(canonical.file),
    title: canonical.passport.title || secondary.passport.title || canonical.id,
    group: canonical.passport.group || secondary.passport.group || '',
    desc: descSource.passport.desc || '',
    descAt: descSource.passport.descAt ?? canonical.passport.descAt ?? secondary.passport.descAt,
    component: canonical.passport.component ?? secondary.passport.component ?? null,
    output: canonical.passport.output || secondary.passport.output || '',
    labels: { ...(secondary.passport.labels || {}), ...(canonical.passport.labels || {}) },
    externalLinks: canonical.passport.externalLinks ?? secondary.passport.externalLinks ?? null,
    tags: uniqueList(orderedSources.map(source => source.passport.tags || [])),
    aliases: uniqueList(orderedSources.map(source => source.passport.aliases || [])),
    status: orderedSources.some(source => source.passport.status === 'described') ? 'described' : (canonical.passport.status || secondary.passport.status || 'needs_description'),
    wordNotes: [...uniqueNotes(allWordNotes).map(({ _sourceFile, ...note }) => note), ...candidateConceptNotes],
    orphanNotes: uniqueNotes(allOrphanNotes).map(({ _sourceFile, ...note }) => note),
    _mergePreviewOnly: true
  };
  if (!candidatePassport.component) delete candidatePassport.component;
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
      componentSources: orderedSources.map(source => ({ file: source.file, component: source.passport.component ?? null })),
      provenanceSources: orderedSources.map(source => ({ file: source.file, source: source.passport.source ?? null })),
      provenanceMergeProposal,
      sourcePassports: orderedSources.map(source => ({ file: source.file, id: source.id, passport: source.passport })),
      conceptNotes,
      noteAnchorConflicts: pair.notes.anchorConflicts,
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
  noteAnchorConflicts: previews.reduce((n, item) => n + item.review.noteAnchorConflicts.length, 0),
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
