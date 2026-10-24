// Тесты токенайзера. Запуск: node tools/code-lab/tests/tokenizer.test.mjs
import assert from 'node:assert/strict';
import { tokenize } from '../lib/tokenizer.mjs';

// удобный вид: «вид:текст» без пробелов, строки через ⏎
const show = (code, lang) => tokenize(code, lang).map(l => l.filter(t => t.k !== 'sp').map(t => t.k + ':' + t.v).join(' ')).join(' ⏎ ');
const text = (code, lang) => tokenize(code, lang).map(l => l.map(t => t.v != null ? t.v : '').join('')).join('\n');
let n = 0;
const test = (name, fn) => { fn(); n++; };

test('кириллические имена — одним токеном', () => {
  assert.equal(show('const база = 20;', 'js'), 'kw:const name:база op:= num:20 op:;');
  assert.equal(show('def площадь(ширина):', 'python'), 'kw:def fn:площадь op:( name:ширина op:) op::');
  const t = tokenize('const база = 20;', 'js')[0].find(x => x.v === 'база');
  assert.equal(t.r, 'база');           // можно переименовывать синхронно
});

test('CSS: дефисные имена, --переменные, цвета, комментарии', () => {
  assert.equal(show('a { font-weight: 700; }', 'css'), 'name:a op:{ name:font-weight op:: num:700 op:; op:}');
  assert.equal(show('--bg: #140A24; /* фон */', 'css'), 'name:--bg op:: num:#140A24 op:; com:/* фон */');
  assert.equal(show('.card-title{}', 'css'), 'op:. name:card-title op:{ op:}');
  assert.equal(show('margin: 0 -1px;', 'css'), 'name:margin op:: num:0 op:- num:1 name:px op:;');
  assert.equal(show('#add { color: #fff; }', 'css'), 'op:# name:add op:{ name:color op:: num:#fff op:; op:}');
  assert.equal(show('grid-template-columns: repeat(3, 1fr);', 'css'), 'name:grid-template-columns op:: fn:repeat op:( num:3 op:, num:1 name:fr op:) op:;');
});

test('CSS: «//» не комментарий (url не обрывается)', () => {
  assert.ok(!show('a{background:url(https://x.ru/a.png)}', 'css').includes('com:'));
});

test('JS и SQL: // и -- остались однострочными комментариями', () => {
  assert.equal(show('x = 1; // заметка', 'js'), 'name:x op:= num:1 op:; com:// заметка');
  assert.equal(show('select 1 -- заметка', 'sql'), 'kw:select num:1 com:-- заметка');
});

test('многострочный /* … */', () => {
  assert.equal(show('/* a\n b */ x', 'js'), 'com:/* a ⏎ com:b */ name:x');
  assert.equal(show('a{}\n/* один\nдва */\nb{}', 'css'), 'name:a op:{ op:} ⏎ com:/* один ⏎ com:два */ ⏎ name:b op:{ op:}');
});

test('многострочная шаблонная строка JS и docstring Python', () => {
  assert.equal(show('const t = `a\n${b}\nc`; f()', 'js'), 'kw:const name:t op:= str:`a ⏎ str:${b} ⏎ str:c` op:; fn:f op:( op:)');
  assert.equal(show('s = """doc\nstring"""\nprint(1)', 'python'), 'name:s op:= str:"""doc ⏎ str:string""" ⏎ fn:print op:( num:1 op:)');
});

test('эмодзи не рассыпаются на половинки', () => {
  assert.equal(show('x = 😀', 'js'), 'name:x op:= op:😀');
  assert.equal(text('x = 😀', 'js'), 'x = 😀');
});

test('прежнее поведение не сломано', () => {
  assert.equal(show('for i in range(3):', 'python'), 'kw:for name:i kw:in fn:range op:( num:3 op:) op::');
  assert.equal(show('for (let i = 0; i < 3; i++) {', 'js'), 'kw:for op:( kw:let name:i op:= num:0 op:; name:i op:< num:3 op:; name:i op:+ op:+ op:) op:{');
  assert.equal(show("const s = 'a\\'b';", 'js'), "kw:const name:s op:= str:'a\\'b' op:;");
});

test('текст из токенов всегда равен исходному (без потерь)', () => {
  const alphabet = ['a', 'Z', 'б', '_', '$', '-', '--', '#', '#fff', '"', "'", '`', '"""', '/*', '*/', '//', '\\', ' ', '\t', '\n', '(', ')', '{', '}', '1', '0x1f', '.', ':', '😀', 'é', '\r\n'];
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const lang of ['js', 'python', 'css', 'sql', 'html', 'svg', 'json', 'неизвестный']) {
    for (let k = 0; k < 400; k++) {
      let s = ''; const len = Math.floor(rnd() * 40);
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      assert.equal(text(s, lang), s.replace(/\r\n/g, '\n'), `${lang}: ${JSON.stringify(s)}`);
    }
  }
});

console.log(`tokenizer: ${n} групп проверок пройдено`);
