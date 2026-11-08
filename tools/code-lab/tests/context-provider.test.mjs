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
  assert.deepEqual(ranked.map(x => x.code), ['end', 'center', 'flex-end']);
  assert.deepEqual(Context.rankCandidates(items, { prefix: '' }), items);
});

test('context preserves syntax constraints and source information', () => {
  const unregister = Context.register({
    id: 'test-metadata',
    resolve: () => ({
      language: 'typescript',
      kind: 'call-argument',
      expected: 'argument-value',
      fn: 'fetch',
      argumentIndex: 1,
      constraints: { allowed: ['string'], required: true },
      relations: [{ type: 'requires', target: 'AbortSignal' }],
      explanation: 'Значение второго аргумента.',
      source: 'typescript-call-adapter',
      sourceRange: { from: 10, to: 14 },
      confidence: 0.8,
      scope: 'function',
      container: 'call',
    }),
  });
  try {
    const result = Context.resolve({ language: 'ts' });
    assert.equal(result.language, 'ts');
    assert.equal(result.callable, 'fetch');
    assert.equal(result.argumentIndex, 1);
    assert.deepEqual(result.constraints, { allowed: ['string'], required: true });
    assert.deepEqual(result.relations, [{ type: 'requires', target: 'AbortSignal' }]);
    assert.equal(result.explanation, 'Значение второго аргумента.');
    assert.equal(result.source, 'typescript-call-adapter');
    assert.deepEqual(result.sourceRange, { from: 10, to: 14 });
    assert.equal(result.confidence, 0.8);
    assert.equal(result.scope, 'function');
    assert.equal(result.container, 'call');
  } finally {
    unregister();
  }
});

test('candidate ranking respects applicability, language, expected kind and prefix', () => {
  const candidates = [
    { code: 'end', expected: 'property-value', languages: ['css'] },
    { code: 'center', expected: 'property-value', languages: ['css'] },
    { code: 'enter', expected: 'argument-value', languages: ['js'] },
    { code: 'enable', expected: 'property-value', languages: ['css'], applicable: false },
    { code: 'enclose', expected: 'property-value', languages: ['css'], contexts: ['selector'] },
    { code: 'end', expected: 'property-value', languages: ['css'] },
  ];
  const ranked = Context.rankCandidates(candidates, {
    prefix: 'en', language: 'css', expected: 'property-value', kind: 'css-value',
  });
  assert.deepEqual(ranked.map(x => x.code), ['end', 'center']);
});

test('stale unregister callback cannot remove a replacement provider', () => {
  const removeOld = Context.register({ id: 'replace-me', resolve: () => ({ kind: 'old' }) });
  const removeNew = Context.register({ id: 'replace-me', resolve: () => ({ kind: 'new' }) });
  removeOld();
  try {
    assert.equal(Context.resolve({}).kind, 'new');
  } finally {
    removeNew();
  }
});

test('a broken provider does not prevent later providers from resolving context', () => {
  const errors = [];
  const removeBroken = Context.register({ id: 'broken', priority: 10, resolve: () => { throw new Error('broken adapter'); } });
  const removeWorking = Context.register({ id: 'working', priority: 1, resolve: () => ({ kind: 'working' }) });
  try {
    const result = Context.resolve({ onProviderError: (error, id) => errors.push([error.message, id]) });
    assert.equal(result.provider, 'working');
    assert.deepEqual(errors, [['broken adapter', 'broken']]);
  } finally {
    removeBroken();
    removeWorking();
  }
});

test('editor snapshot exposes stable cursor, line and token context', () => {
  const snapshot = Context.createSnapshot({
    language: 'javascript',
    code: 'const total = values.re',
    cursor: { line: 0, ch: 23 },
    selectedText: '',
  });
  assert.equal(snapshot.language, 'js');
  assert.equal(snapshot.currentLine, 'const total = values.re');
  assert.equal(snapshot.beforeCursor, 'const total = values.re');
  assert.equal(snapshot.afterCursor, '');
  assert.equal(snapshot.prefix, 're');
  assert.deepEqual(snapshot.cursor, { line: 0, ch: 23 });
});

test('editor snapshot handles multiline code and clamps negative cursor positions', () => {
  const snapshot = Context.createSnapshot({
    language: 'py',
    code: 'first line\nsecond line',
    cursor: { line: 1, ch: -4 },
  });
  assert.equal(snapshot.language, 'python');
  assert.equal(snapshot.currentLine, 'second line');
  assert.equal(snapshot.beforeCursor, '');
  assert.equal(snapshot.afterCursor, 'second line');
});
