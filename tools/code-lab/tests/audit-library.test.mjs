import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(ROOT, 'tools', 'code-lab', 'scripts', 'audit-library.mjs');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'code-lab-audit-library-'));

try {
  const library = path.join(temporary, 'library');
  await fs.mkdir(library, { recursive: true });
  await fs.writeFile(path.join(library, 'sample.js'), 'const value = 1;\\n');
  await fs.writeFile(path.join(library, 'sample.js.meta.json'), JSON.stringify({
    id: 'sample',
    lang: 'js',
    wordNotes: [{
      line: 0,
      col: 0,
      text: '',
      kind: 'const — объявляет переменную',
      note: 'kw',
      source: 'dict'
    }]
  }));

  const run = spawnSync(process.execPath, [SCRIPT, library], {
    cwd: temporary,
    encoding: 'utf8'
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(await fs.readFile(path.join(temporary, 'audit-library-report.json'), 'utf8'));

  assert.equal(report.notes.invalid, 1, 'empty token text must be classified as invalid');
  assert.equal(report.notes.swapped, 1, 'field inversion must still be detected for invalid notes');
  assert.equal(report.notes.composite, 0, 'an empty token must not pass as a composite match');
  assert.equal(report.noteCases[0].classification, 'empty-token-text');
  assert.equal(report.noteCases[0].swapped, true);
  assert.equal(report.noteCases[0].text, '');
  console.log('audit-library: empty note anchors are reported as invalid without losing swap diagnostics');

  const lexicalLibrary = path.join(temporary, 'lexical-library');
  await fs.mkdir(lexicalLibrary, { recursive: true });
  await fs.writeFile(path.join(lexicalLibrary, 'tokens.js'), 'const result = await fetch(url);\\nconst awaitResult = result;\\n');
  await fs.writeFile(path.join(lexicalLibrary, 'tokens.js.meta.json'), JSON.stringify({
    id: 'tokens',
    lang: 'js',
    wordNotes: [
      { line: 0, col: 0, text: 'await', kind: 'kw', note: 'Ожидание результата.', source: 'custom' },
      { line: 0, col: 0, text: 'a', kind: 'name', note: 'Переменная.', source: 'custom' }
    ]
  }));
  const lexicalRun = spawnSync(process.execPath, [SCRIPT, lexicalLibrary], {
    cwd: temporary,
    encoding: 'utf8'
  });
  assert.equal(lexicalRun.status, 0, lexicalRun.stderr || lexicalRun.stdout);
  const lexicalReport = JSON.parse(await fs.readFile(path.join(temporary, 'audit-library-report.json'), 'utf8'));
  assert.equal(lexicalReport.notes.uniqueToken, 1, 'await must match as a complete identifier, not its prefix inside awaitResult');
  assert.equal(lexicalReport.notes.multipleTokens, 0, 'identifier substrings must not inflate repeated-token counts');
  assert.equal(lexicalReport.notes.absent, 1, 'single-letter a must not match inside await or fetch');
  assert.equal(lexicalReport.notes.composite, 0, 'identifier substrings are not composite code expressions');
  console.log('audit-library: identifier matching respects token boundaries');
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
