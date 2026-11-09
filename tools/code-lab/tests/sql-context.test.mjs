import test from 'node:test';
import assert from 'node:assert/strict';
import SQLContext from '../public/sql-context.js';

function resolve(code, language = 'sql') {
  const lines = code.split(/\r\n|\n|\r/);
  const line = lines.length - 1;
  return SQLContext.resolve({
    language,
    code,
    cursor: { line, ch: lines[line].length }
  });
}

test('SQL context distinguishes statement, select, source and condition positions', () => {
  assert.equal(resolve('SEL').kind, 'sql-statement');
  assert.equal(resolve('SELECT na').kind, 'sql-select-list');
  assert.equal(resolve('SELECT name FROM ').kind, 'sql-table-source');
  assert.equal(resolve('SELECT name FROM users WHERE ').kind, 'sql-condition');
  assert.equal(resolve('SELECT * FROM users JOIN ').kind, 'sql-table-source');
  assert.equal(resolve('SELECT * FROM users JOIN orders ON ').kind, 'sql-join-condition');
});

test('SQL context recognizes grouping, sorting, update and values clauses', () => {
  assert.equal(resolve('SELECT department FROM staff GROUP BY ').kind, 'sql-group-order');
  assert.equal(resolve('SELECT department FROM staff ORDER BY ').kind, 'sql-group-order');
  assert.equal(resolve('UPDATE staff SET ').kind, 'sql-assignment');
  assert.equal(resolve('INSERT INTO staff VALUES (').kind, 'sql-values');
});

test('SQL context delegates function parentheses to the shared call-argument provider', () => {
  assert.equal(resolve('SELECT COALESCE(price, '), null);
});

test('SQL context suppresses suggestions inside strings and comments', () => {
  assert.equal(resolve("SELECT 'unfinished").suppressAutocomplete, true);
  assert.equal(resolve('SELECT name -- unfinished comment').suppressAutocomplete, true);
});

test('SQL line comments end at a newline and CRLF offsets remain correct', () => {
  const result = resolve('SELECT name -- comment\r\nFROM users');
  assert.equal(result.kind, 'sql-table-source');
  assert.equal(result.prefix, 'users');
  assert.equal(result.sourceRange.to, 'SELECT name -- comment\r\nFROM users'.length);
});

test('SQL context ignores non-SQL languages', () => {
  assert.equal(resolve('SELECT name', 'javascript'), null);
});


test('SQL clause detection resets after a statement separator', () => {
  const result = resolve('SELECT old_name FROM old_table; SELECT ne');
  assert.equal(result.kind, 'sql-select-list');
  assert.equal(result.prefix, 'ne');
});
