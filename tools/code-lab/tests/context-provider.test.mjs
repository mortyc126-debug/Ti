import test from 'node:test';
import assert from 'node:assert/strict';
import Context from '../public/context-provider.js';

test('context provider normalizes language aliases and common context fields', () => {
  const unregister = Context.register({
    id: 'test-css-value',
    languages: ['css'],
    priority: 10,
    resolve: ({ language }) => language === 'css' ? {
      kind: 'css-value',
      fn: 'align-items',
      prefix: 'en',
      x: 12,
      y: 34,
      put: () => {},
    } : null,
  });
  try {
    const result = Context.resolve({ language: 'CSS' });
    assert.equal(result.provider, 'test-css-value');
    assert.equal(result.language, 'css');
    assert.equal(result.kind, 'css-value');
    assert.equal(result.syntaxPosition, 'css-value');
    assert.equal(result.expected, 'construct');
    assert.equal(result.prefix, 'en');
    assert.equal(result.symbol, 'align-items');
    assert.deepEqual(result.position, { x: 12, y: 34 });
    assert.equal(typeof result.replace, 'function');
  } finally {
    unregister();
  }
});

test('context provider selects the highest-priority matching language adapter', () => {
  const removeLow = Context.register({
    id: 'test-low',
    languages: ['javascript'],
    priority: 1,
    resolve: () => ({ kind: 'low' }),
  });
  const removeHigh = Context.register({
    id: 'test-high',
    languages: ['js'],
    priority: 5,
    resolve: () => ({ kind: 'high' }),
  });
  try {
    assert.equal(Context.resolve({ language: 'js' }).provider, 'test-high');
    assert.equal(Context.resolve({ language: 'python' }), null);
  } finally {
    removeLow();
    removeHigh();
  }
});

test('candidate ranking prefers prefix matches and preserves stable order', () => {
  const items = [
    { code: 'end', note: 'конец' },
    { code: 'center', note: 'центр' },
    { code: 'flex-end', note: 'конец flex' },
    { code: 'start', note: 'начало' },
  ];
  const ranked = Context.rankCandidates(items, { prefix: 'en' });
  assert.deepEqual(ranked.map(x => x.code), ['end', 'center']);
  assert.deepEqual(Context.rankCandidates(items, { prefix: '' }), items);
});
