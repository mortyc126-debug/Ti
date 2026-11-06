// Builds a review-only merge manifest from audit-library-report.json.
// It never edits library files and never chooses data to discard.
import fs from 'node:fs/promises';
import path from 'node:path';

const input = path.resolve(process.argv[2] || 'audit-library-report.json');
const output = path.resolve(process.argv[3] || 'duplicate-merge-manifest.json');
const report = JSON.parse(await fs.readFile(input, 'utf8'));
if (!Array.isArray(report.duplicateReview)) throw new Error('В отчёте нет duplicateReview');

const stableId = id => !/-mv[a-z0-9]{6,}$/i.test(String(id || ''));
const norm = value => String(value == null ? '' : value).trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
const unique = values => {
  const seen = new Set(), out = [];
  for (const value of values.flatMap(x => Array.isArray(x) ? x : [x])) {
    if (value == null || value === '') continue;
    const key = norm(typeof value === 'string' ? value : JSON.stringify(value));
    if (!key || seen.has(key)) continue;
    seen.add(key); out.push(value);
  }
  return out;
};
const noteAnchor = n => [n.line ?? null, n.col ?? null, n.text ?? ''].join('|');
const noteIdentity = n => [noteAnchor(n), n.note ?? '', n.kind ?? '', n.source ?? ''].join('|');

const pairs = report.duplicateReview.map((group, index) => {
  const files = group.files || [];
  const candidates = files.filter(f => stableId(f.id));
  const canonical = candidates.length === 1 ? candidates[0] : null;
  const secondary = canonical ? files.filter(f => f !== canonical) : [];
  const allNotes = files.flatMap(file => [
    ...(file.metaSummary?.wordNotes || []).map(note => ({ ...note, from: file.file, collection: 'wordNotes' })),
    ...(file.metaSummary?.orphanNotes || []).map(note => ({ ...note, from: file.file, collection: 'orphanNotes' }))
  ]);
  const uniqueNotes = new Map();
  for (const note of allNotes) if (!uniqueNotes.has(noteIdentity(note))) uniqueNotes.set(noteIdentity(note), note);
  const byAnchor = new Map();
  for (const note of allNotes.filter(n => n.kind !== 'concept')) {
    const key = noteAnchor(note);
    if (!byAnchor.has(key)) byAnchor.set(key, []);
    byAnchor.get(key).push(note);
  }
  const noteConflicts = [];
  for (const [anchor, notes] of byAnchor) {
    const distinct = values => [...new Set(values.map(value => String(value == null ? '' : value)))];
    const explanations = distinct(notes.map(n => n.note));
    const kinds = distinct(notes.map(n => n.kind));
    const sources = distinct(notes.map(n => n.source));
    if (explanations.length > 1 || kinds.length > 1 || sources.length > 1) {
      noteConflicts.push({ anchor, explanations, kinds, sources, records: notes });
    }
  }
  const metas = files.map(f => ({ file: f.file, id: f.id, meta: f.metaSummary || {} }));
  const fields = ['title', 'group', 'desc', 'tags', 'aliases', 'status', 'component', 'source', 'externalLinks'];
  const differences = fields.filter(field => {
    const vals = metas.map(x => JSON.stringify(x.meta[field] ?? null));
    return new Set(vals).size > 1;
  });
  const descriptions = files.map(f => ({ file: f.file, value: String(f.metaSummary?.desc || '') })).sort((a, b) => b.value.length - a.value.length);
  const codeUrls = unique(files.flatMap(f => f.codeUrls || []));
  const metaUrls = unique(files.flatMap(f => f.metaUrls || []));
  return {
    pair: index + 1,
    codeIdentical: files.length > 1 && files.every(f => f.rawHash === files[0].rawHash),
    codeHash: files[0]?.rawHash || null,
    status: canonical ? 'proposed-canonical-needs-review' : 'manual-canonical-choice-required',
    canonical: canonical ? { file: canonical.file, id: canonical.id } : null,
    legacyIds: canonical ? secondary.map(f => ({ id: f.id, file: f.file, redirectTo: canonical.id })) : [],
    files: metas,
    differingFields: differences,
    proposedFieldMerge: {
      desc: descriptions[0] || null,
      tags: unique(files.flatMap(f => f.metaSummary?.tags || [])),
      aliases: unique(files.flatMap(f => f.metaSummary?.aliases || [])),
      component: 'merge both objects by key; resolve nested conflicts manually',
      source: 'preserve provenance per field; do not infer that longer text is manually authored',
      status: files.some(f => f.metaSummary?.status === 'described') ? 'described' : 'needs_description'
    },
    notes: {
      sourceRecordCount: allNotes.length,
      exactRecordCountAfterDeduplication: uniqueNotes.size,
      exactDuplicates: allNotes.length - uniqueNotes.size,
      wordNotes: allNotes.filter(n => n.collection === 'wordNotes' && n.kind !== 'concept'),
      orphanNotes: allNotes.filter(n => n.collection === 'orphanNotes' && n.kind !== 'concept'),
      conceptNotes: allNotes.filter(n => n.kind === 'concept'),
      anchorConflicts: noteConflicts
    },
    urls: { code: codeUrls, passport: metaUrls, union: unique([...codeUrls, ...metaUrls]) }
  };
});

const summary = {
  pairCount: pairs.length,
  identicalCodePairs: pairs.filter(p => p.codeIdentical).length,
  proposedCanonicalCount: pairs.filter(p => p.canonical).length,
  unresolvedCanonicalCount: pairs.filter(p => !p.canonical).length,
  pairsWithFieldDifferences: pairs.filter(p => p.differingFields.length).length,
  noteRecords: pairs.reduce((n, p) => n + p.notes.sourceRecordCount, 0),
  deduplicatedNoteRecords: pairs.reduce((n, p) => n + p.notes.exactRecordCountAfterDeduplication, 0),
  noteAnchorConflicts: pairs.reduce((n, p) => n + p.notes.anchorConflicts.length, 0),
  conceptNotes: pairs.reduce((n, p) => n + p.notes.conceptNotes.length, 0),
  urls: unique(pairs.flatMap(p => p.urls.union)).length
};
const manifest = {
  schemaVersion: 1,
  generatedAt: report.generatedAt,
  sourceReport: path.basename(input),
  mode: 'review-only; no source files changed',
  rules: {
    canonical: 'propose the sole ID without a generated -mv... suffix; retain the other ID in a separate compatibility map',
    code: 'only group files with identical rawHash; code is not rewritten by this manifest',
    notes: 'preserve every distinct note record; same-anchor records with differing explanation, kind, or source require review',
    concepts: 'kind=concept is kept separate from ordinary token notes',
    component: 'never discard either component object; nested conflicts require review',
    urls: 'preserve URLs as data; do not assume every URL is documentation'
  },
  summary,
  pairs
};
await fs.writeFile(output, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ output, summary }, null, 2));
