// Read-only scan for references to legacy IDs proposed for duplicate consolidation.
// No file contents are copied into the report; only paths, counts and JSON paths are recorded.
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'tools/code-lab');
const manifestPath = path.resolve(process.argv[3] || 'duplicate-merge-manifest.json');
const outputPath = path.resolve(process.argv[4] || 'duplicate-id-reference-report.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const legacy = new Map();
for (const pair of manifest.pairs || []) for (const item of pair.legacyIds || []) legacy.set(item.id, item.redirectTo);
const roots = ['tasks', 'recipes', 'flows', 'data', 'workspace'];
const allowed = new Set(['.json', '.txt', '.md', '.js', '.mjs', '.html', '.yml', '.yaml']);
const files = [];
async function walk(dir, rel = '') {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || ['node_modules', 'vendor'].includes(entry.name)) continue;
    const abs = path.join(dir, entry.name), childRel = rel ? path.posix.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) await walk(abs, childRel);
    else if (entry.isFile() && allowed.has(path.extname(entry.name).toLowerCase())) files.push({ abs, rel: childRel });
  }
}
for (const name of roots) await walk(path.join(root, name), name);

const references = [];
for (const file of files) {
  const content = await fs.readFile(file.abs, 'utf8');
  let json = null;
  if (path.extname(file.rel).toLowerCase() === '.json') {
    try { json = JSON.parse(content); } catch (_) {}
  }
  if (json !== null) {
    const visit = (value, jsonPath) => {
      if (typeof value === 'string' && legacy.has(value)) references.push({ id: value, redirectTo: legacy.get(value), file: file.rel, jsonPath });
      else if (Array.isArray(value)) value.forEach((v, i) => visit(v, jsonPath + '[' + i + ']'));
      else if (value && typeof value === 'object') for (const [key, v] of Object.entries(value)) {
        if (legacy.has(key)) references.push({ id: key, redirectTo: legacy.get(key), file: file.rel, jsonPath: jsonPath + '.' + key, keyReference: true });
        visit(v, jsonPath + '.' + key);
      }
    };
    visit(json, '$');
  } else {
    for (const [id, redirectTo] of legacy) {
      let at = -1, count = 0, lineNumbers = [];
      while ((at = content.indexOf(id, at + 1)) !== -1) {
        count++;
        lineNumbers.push(content.slice(0, at).split('\n').length);
      }
      if (count) references.push({ id, redirectTo, file: file.rel, count, lineNumbers: [...new Set(lineNumbers)] });
    }
  }
}
const counts = new Map();
for (const ref of references) counts.set(ref.id, (counts.get(ref.id) || 0) + (ref.count || 1));
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode: 'read-only; scanned persisted project data only',
  rootsScanned: roots,
  filesScanned: files.length,
  legacyIdsTotal: legacy.size,
  referencedLegacyIds: [...counts.keys()].length,
  unreferencedLegacyIds: [...legacy.keys()].filter(id => !counts.has(id)),
  referenceCount: references.reduce((n, r) => n + (r.count || 1), 0),
  references
};
await fs.writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ output: outputPath, filesScanned: report.filesScanned, legacyIdsTotal: report.legacyIdsTotal, referencedLegacyIds: report.referencedLegacyIds, referenceCount: report.referenceCount }, null, 2));
