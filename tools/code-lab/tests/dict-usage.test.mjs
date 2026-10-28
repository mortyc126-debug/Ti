import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUsage, dictSections, libraryFingerprint } from '../lib/dict-usage.mjs';

const piece = (id, lang, code) => ({ id, lang, title: id, code });

test('JS: идиомы с подстановками находят куски с другими именами переменных', () => {
  const dict = { langs: { js: {
    'controller.abort()': 'отмена', 'fetch': 'запрос', 'console.log': 'вывод',
    'array.reduce((acc, item) => combine(acc, item), initial)': 'свёртка',
    'new intl.numberformat(locale, { style': 'формат', '"use strict"': 'строгий режим',
    'object.keys(obj)': 'ключи', 'array.from(iterable)': 'массив из', 'element.nodename': 'имя узла',
    'temporal.now.instant()': 'нет такого куска',
  } } };
  const u = buildUsage(dict, [
    piece('a', 'js', 'const ctrl = new AbortController();\nctrl.abort();'),
    piece('b', 'js', 'const total = nums.reduce((s, n) => s + n, 0);'),
    piece('c', 'js', '"use strict";\nconst f = new Intl.NumberFormat("ru", { style: "currency", currency: "RUB" });\nconsole.log(Object.keys(x), Array.from(set), el.nodeName);'),
    piece('d', 'js', '// fetch(url) в комментарии\nconst s = "fetch(url) в строке";'),
  ]);
  const has = (t, id) => u.piecesOf('lang:js', t).includes(id);
  assert.ok(has('controller.abort()', 'a'));
  assert.ok(has('array.reduce((acc, item) => combine(acc, item), initial)', 'b'));
  assert.ok(has('"use strict"', 'c'));
  assert.ok(has('new intl.numberformat(locale, { style', 'c'));
  assert.ok(has('console.log', 'c'));
  assert.ok(has('object.keys(obj)', 'c'));
  assert.ok(has('array.from(iterable)', 'c'));
  assert.ok(has('element.nodename', 'c'));
  assert.equal(u.piecesOf('lang:js', 'fetch').length, 0, 'комментарий и строка не считаются');
  assert.equal(u.piecesOf('lang:js', 'temporal.now.instant()').length, 0);
  // не путает чужие формы: reduce не находит abort и наоборот
  assert.ok(!has('controller.abort()', 'b'));
});

test('пробелы: gaps() возвращает термины без кусков; русские ключи — не код', () => {
  const dict = { langs: { js: { 'fetch': 'запрос', 'structuredclone': 'копия', 'ошибка границ': 'глоссарий' } } };
  const u = buildUsage(dict, [piece('a', 'js', 'fetch("/x")')]);
  const s = u.sections.find(x => x.id === 'lang:js');
  assert.equal(s.covered, 1); assert.equal(s.uncovered, 1); assert.equal(s.prose, 1);
  assert.deepEqual(u.gaps('lang:js').map(g => g.term), ['structuredclone']);
});

test('язык куска важен: python-кусок не закрывает js-термин, «общее» видит все языки', () => {
  const dict = { words: { 'try': 'пробовать' }, langs: { js: { 'fetch': 'запрос' }, python: { 'with open(path) as f': 'файл' } } };
  const u = buildUsage(dict, [piece('p', 'python', 'try:\n    pass\nexcept: pass\nwith open("a.txt") as fh:\n    data = fh.read()\n'), piece('j', 'js', 'try { fetch(u) } catch(e) {}')]);
  assert.deepEqual(u.piecesOf('lang:js', 'fetch'), ['j']);
  assert.deepEqual(u.piecesOf('lang:python', 'with open(path) as f'), ['p']);
  assert.deepEqual(u.piecesOf('common', 'try').sort(), ['j', 'p']);
});

test('C/C++: #include и std::cout; Python-комментарии не считаются', () => {
  const dict = { langs: { cpp: { '#include': 'подключить', 'std::cout': 'вывод' }, python: { 'print': 'печать' } } };
  const u = buildUsage(dict, [piece('c', 'cpp', '#include <iostream>\nint main(){ std::cout << 1; }'), piece('p', 'python', '# print(1)\nx = 2')]);
  assert.deepEqual(u.piecesOf('lang:cpp', '#include'), ['c']);
  assert.deepEqual(u.piecesOf('lang:cpp', 'std::cout'), ['c']);
  assert.deepEqual(u.piecesOf('lang:python', 'print'), []);
});

test('HTML/CSS: слова словаря ищутся в разметке и стилях', () => {
  const dict = { htmlTags: { dialog: 'окно' }, cssProps: { 'grid-template-columns': 'колонки', 'aspect-ratio': 'пропорции' }, cssVals: { '1fr': 'доля' } };
  const u = buildUsage(dict, [piece('h', 'html', '<dialog open><p>hi</p></dialog><!-- aspect-ratio -->'), piece('s', 'css', '.a{display:grid;grid-template-columns:1fr 1fr}')]);
  assert.deepEqual(u.piecesOf('html', 'dialog'), ['h']);
  assert.deepEqual(u.piecesOf('css', 'grid-template-columns'), ['s']);
  assert.deepEqual(u.piecesOf('css', '1fr'), ['s']);
  assert.deepEqual(u.gaps('css').map(g => g.term), ['aspect-ratio']);
});

test('termsOfPiece: «где ещё используется» исключает сам кусок', () => {
  const dict = { langs: { js: { 'controller.abort()': 'отмена' } } };
  const u = buildUsage(dict, [piece('a', 'js', 'c.abort()'), piece('b', 'js', 'ctrl.abort()')]);
  const t = u.termsOfPiece('a');
  assert.equal(t.length, 1); assert.equal(t[0].n, 2); assert.deepEqual(t[0].others, ['b']);
});

test('dictSections и отпечаток библиотеки', () => {
  const s = dictSections({ htmlTags: { a: 'x' }, langs: { html: { b: 'y' }, js: { c: 'z' } }, words: { d: 'w' } });
  assert.deepEqual(Object.keys(s).sort(), ['common', 'html', 'lang:js']);
  assert.deepEqual(Object.keys(s.html).sort(), ['a', 'b']);
  const f1 = libraryFingerprint([piece('a', 'js', 'x')]), f2 = libraryFingerprint([piece('a', 'js', 'y')]);
  assert.notEqual(f1, f2);
  assert.equal(f1, libraryFingerprint([piece('a', 'js', 'x')]));
});
