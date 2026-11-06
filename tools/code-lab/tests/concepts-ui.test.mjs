import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');
const htmlPath = path.join(publicDir, 'concepts.html');
const jsPath = path.join(publicDir, 'concepts.js');
const cssPath = path.join(publicDir, 'style.css');
const [html, js, css] = await Promise.all([
  fs.readFile(htmlPath, 'utf8'), fs.readFile(jsPath, 'utf8'), fs.readFile(cssPath, 'utf8')
]);
const syntax = spawnSync(process.execPath, ['--check', jsPath], { encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);
assert.ok(html.includes('src="/concepts.js"'));
assert.ok(html.includes('href="/style.css"'));
assert.ok(js.includes('/api/concepts/search'));
assert.ok(js.includes('/api/concepts/save'));
assert.ok(css.includes('.concept-layout'));
console.log('concepts-ui: 6 checks passed');
