import test from 'node:test';
import assert from 'node:assert/strict';
import SQLCandidates from '../public/sql-candidates.js';

const dictionary = {
  langs: {
    sql: {
      select: 'выбирает поля',
      from: 'указывает источник',
      where: 'фильтрует строки',
      join: 'соединяет таблицы',
      and: 'логическое И',
      is: 'проверка значения',
      count: 'считает строки',
      coalesce: 'первое значение не NULL'
    }
  }
};

test('SQL candidate lists are scoped to the active clause and prefix', () => {
  const result = SQLCandidates.candidates(dictionary, {
    kind: 'sql-select-list', expected: 'column-or-expression', prefix: 'co'
  });
  assert.deepEqual(result.map(item => item.code), ['COALESCE']);
  assert.equal(result[0].note, 'первое значение не NULL');
  assert.deepEqual(result[0].contexts, ['sql-select-list']);
});

test('SQL condition candidates contain operators rather than table clauses', () => {
  const result = SQLCandidates.candidates(dictionary, {
    kind: 'sql-condition', expected: 'sql-condition', prefix: 'is'
  });
  assert.deepEqual(result.map(item => item.code), ['IS']);
});

test('SQL table-source candidates include declared CTE names with explanations', () => {
  const code = 'WITH active_users AS (SELECT id FROM users) SELECT * FROM act';
  const result = SQLCandidates.candidates(dictionary, {
    kind: 'sql-table-source', expected: 'table-or-cte', prefix: 'act'
  }, code);
  assert.deepEqual(result.map(item => item.code), ['ACTIVE_USERS']);
  assert.match(result[0].note, /CTE/);
});

test('unknown SQL contexts do not produce generic candidates', () => {
  assert.deepEqual(SQLCandidates.candidates(dictionary, {
    kind: 'sql-string', expected: 'none', prefix: ''
  }), []);
});
