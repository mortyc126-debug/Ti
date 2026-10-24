// Разбор txt-списка кусков. Запуск: node tools/code-lab/tests/ingest.test.mjs
import assert from 'node:assert/strict';
import { parseSnippets, detectLang } from '../lib/ingest.mjs';
let n = 0; const test = (name, fn) => { try { fn(); n++; } catch (e) { e.message = `[${name}] ` + e.message; throw e; } };

test('разделители, пометки, язык и раздел', () => {
  const { pieces } = parseSnippets('=== A | css | Раздел\nописание: д\nтеги: x, y\nsynonyms: z\nр { a: b; }\n=== B\nlet a = 1;');
  assert.equal(pieces.length, 2);
  assert.deepEqual([pieces[0].title, pieces[0].lang, pieces[0].group, pieces[0].desc, pieces[0].tags], ['A', 'css', 'Раздел', 'д', ['x', 'y']]);
  assert.equal(pieces[0].code, 'р { a: b; }');
  assert.equal(pieces[1].lang, 'js');
});
test('CRLF и BOM', () => {
  const { pieces } = parseSnippets('﻿=== A\r\nlet a = 1;\r\nlet b = 2;\r\n');
  assert.equal(pieces[0].code, 'let a = 1;\nlet b = 2;');
});
test('блоки в тройных кавычках, название — строка перед блоком', () => {
  const { pieces } = parseSnippets('## Список\n```python\nfor i in range(3):\n    print(i)\n```\n```sql extra\nSELECT 1 FROM t;\n```');
  assert.equal(pieces[0].title, 'Список'); assert.equal(pieces[0].lang, 'python');
  assert.equal(pieces[1].lang, 'sql'); assert.equal(pieces[1].title, 'extra');
});
test('без разделителей — один кусок с предупреждением; пустые блоки пропускаются', () => {
  const r = parseSnippets('// шапка\nconsole.log(1);');
  assert.equal(r.pieces.length, 1); assert.equal(r.pieces[0].title, 'шапка'); assert.equal(r.warnings.length, 1);
  assert.equal(parseSnippets('=== A\n\n=== B\nx = 1').pieces.length, 1);
  assert.equal(parseSnippets('').pieces.length, 0);
});
test('значения по умолчанию и пометка внутри кода не ломают код', () => {
  const r = parseSnippets('=== A\nконстанта = 5\nесли: да', { lang: 'txt', group: 'Г' });
  assert.equal(r.pieces[0].group, 'Г'); assert.equal(r.pieces[0].lang, 'txt');
  assert.equal(r.pieces[0].code, 'константа = 5\nесли: да');
});
test('определение языка', () => {
  assert.equal(detectLang('<div class="a">x</div>'), 'html');
  assert.equal(detectLang('.a { color: red; }'), 'css');
  assert.equal(detectLang('const a = () => 1;'), 'js');
  assert.equal(detectLang('def f():\n    return 1'), 'python');
  assert.equal(detectLang('SELECT * FROM users WHERE id = 1;'), 'sql');
  assert.equal(detectLang('привет'), 'txt');
});
console.log(`ingest: ${n} групп проверок пройдено`);
