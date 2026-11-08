import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeLook, annotateLines } from '../lib/annotate.mjs';
import { tokenize } from '../lib/tokenizer.mjs';
import { analyzeNames } from '../lib/code-names.mjs';
import { explainNames } from '../lib/contract-labels.mjs';

test('SQL annotation prefers SQL dictionary over generic words', () => {
  const dict = {
    words: { from: 'общий смысл from', join: 'общий смысл join' },
    langs: { sql: { from: 'SQL: источник таблиц', join: 'SQL: соединение таблиц' } },
  };
  const look = makeLook('sql', dict);
  assert.equal(look('FROM'), 'SQL: источник таблиц');
  assert.equal(look('JOIN'), 'SQL: соединение таблиц');
  assert.equal(look('missing'), null);
});

test('TypeScript annotation prefers TS terms and falls back to JS for shared syntax', () => {
  const dict = {
    words: { const: 'общее const' },
    langs: {
      js: { const: 'JS const', console: 'JS console' },
      ts: { type: 'TS type', const: 'TS const' },
    },
  };
  const look = makeLook('ts', dict);
  assert.equal(look('type'), 'TS type');
  assert.equal(look('const'), 'TS const');
  assert.equal(look('console'), 'JS console');
});

test('annotateLines does not replace an existing explanation', () => {
  const lines = [[
    { k: 'kw', v: 'from' },
    { k: 'kw', v: 'join', e: 'ручное пояснение' },
  ]];
  const count = annotateLines(lines, 'sql', {
    words: {},
    langs: { sql: { from: 'SQL FROM', join: 'SQL JOIN' } },
  });
  assert.equal(count, 1);
  assert.equal(lines[0][0].e, 'SQL FROM');
  assert.equal(lines[0][1].e, 'ручное пояснение');
});

test('TypeScript-only keywords are tokenized as keywords', () => {
  const tokens = tokenize('type Публичный = Readonly<Пользователь>;', 'ts').flat();
  const keywordValues = tokens.filter(t => t.k === 'kw').map(t => t.v);
  assert.ok(keywordValues.includes('type'));
  assert.ok(keywordValues.includes('Readonly') === false, 'utility type remains a name');
  const classTokens = tokenize('class Сервис { private readonly имя: string; }', 'ts').flat();
  const classKeywords = classTokens.filter(t => t.k === 'kw').map(t => t.v);
  for(const word of ['class', 'private', 'readonly', 'string']) assert.ok(classKeywords.includes(word), word);
});

test('SQL transaction keywords and COALESCE receive the right token kinds', () => {
  const tokens = tokenize('DEFAULT 0; COMMIT; ROLLBACK; COALESCE(price, 0); COUNT(price); SUM(price); AVG(price); MIN(price); MAX(price);', 'sql').flat();
  const kind = word => tokens.find(t => t.v && t.v.toLowerCase() === word.toLowerCase())?.k;
  for(const word of ['DEFAULT', 'COMMIT', 'ROLLBACK']) assert.equal(kind(word), 'kw', word);
  for(const word of ['COALESCE', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX']) assert.equal(kind(word), 'fn', word);
});

test('TypeScript name explanations prefer TS dictionary before JS fallback', () => {
  const result = explainNames('const Profile = 1;', 'ts', ['Profile'], {
    words: {},
    langs: {
      js: { profile: 'JS meaning' },
      ts: { profile: 'TypeScript meaning' },
    },
  });
  assert.match(result.Profile.text, /TypeScript meaning/);
});

test('TypeScript-specific method names are known during typo analysis', () => {
  const result = analyzeNames('const client = {}; client.specialMethod();', 'ts', {
    dict: { langs: { ts: { 'client.specialMethod()': 'специальный метод' } } },
  });
  assert.deepEqual(result.typos, []);
});


test('реальный словарь даёт языковые пояснения для одинаковых ключевых слов', () => {
  const dict = JSON.parse(fs.readFileSync(new URL('../public/keyword-dict.json', import.meta.url), 'utf8'));
  dict.langs = {};
  for (const lang of ['python', 'js', 'sql', 'ts', 'html', 'css']) {
    dict.langs[lang] = JSON.parse(fs.readFileSync(new URL('../public/dict/langs/' + lang + '.json', import.meta.url), 'utf8'));
  }
  const py = makeLook('python', dict), js = makeLook('js', dict), sql = makeLook('sql', dict), html = makeLook('html', dict), ts = makeLook('ts', dict);
  assert.match(py('await'), /coroutine|awaitable/i);
  assert.doesNotMatch(py('await'), /Promise|промис/i);
  assert.match(js('await'), /Promise|thenable/i);
  assert.match(py('for'), /итерируем/);
  assert.match(js('for'), /инициализацией/);
  assert.match(py('in'), /принадлеж/);
  assert.match(js('in'), /свойств/);
  assert.match(py('from'), /from модуль import/);
  assert.match(js('from'), /ES import/);
  assert.match(sql('from'), /источник строк/);
  assert.match(py('as'), /псевдоним/);
  assert.match(sql('as'), /псевдоним столбца/);
  assert.match(py('with'), /контекстный менеджер/);
  assert.match(sql('with'), /CTE/);
  assert.match(html('for'), /label/);
  assert.match(ts('as'), /утверждает тип/);
  assert.match(py('False'), /Python/);
  assert.match(js('false'), /JavaScript/);
});
