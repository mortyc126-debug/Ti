import test from 'node:test';
import assert from 'node:assert/strict';
import CSSShorthands from '../public/css-shorthands.js';

test('place-* shorthand registry preserves specification component order', () => {
  assert.deepEqual(CSSShorthands.get('place-items').components, ['align-items', 'justify-items']);
  assert.deepEqual(CSSShorthands.get('place-content').components, ['align-content', 'justify-content']);
  assert.deepEqual(CSSShorthands.get('place-self').components, ['align-self', 'justify-self']);
  assert.deepEqual(CSSShorthands.get('place-items').valueOrder, ['align-items', 'justify-items']);
});

test('one shorthand value expands to both component properties', () => {
  const result = CSSShorthands.expand('place-items', ['center']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.declarations, {
    'align-items': 'center',
    'justify-items': 'center',
  });
});

test('two shorthand values expand in declared order', () => {
  const result = CSSShorthands.expand('place-content', ['safe center', 'space-between']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.declarations, {
    'align-content': 'safe center',
    'justify-content': 'space-between',
  });
});

test('longhand lookup returns its shorthand relation', () => {
  assert.deepEqual(CSSShorthands.forLonghand('justify-items').map(x => x.name), ['place-items']);
  assert.deepEqual(CSSShorthands.forLonghand('align-content').map(x => x.name), ['place-content']);
});

test('collapse is blocked unless cascade, comments, duplicates and reset effects are reviewed', () => {
  const result = CSSShorthands.collapse('place-items', {
    'align-items': 'center',
    'justify-items': 'center',
  }, { commentsPreserved: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsafe-source-range');
  assert.deepEqual(result.missing, [
    'noDuplicates',
    'cascadePreserved',
    'resetEffectsReviewed',
    'grammarValidated',
  ]);
});

test('collapse only emits a shorthand after all safety checks pass', () => {
  const result = CSSShorthands.collapse('place-items', {
    'align-items': 'center',
    'justify-items': 'end',
  }, {
    commentsPreserved: true,
    noDuplicates: true,
    cascadePreserved: true,
    resetEffectsReviewed: true,
    grammarValidated: true,
  });
  assert.deepEqual(result, {
    ok: true,
    shorthand: 'place-items',
    value: 'center end',
    components: ['align-items', 'justify-items'],
  });
});
