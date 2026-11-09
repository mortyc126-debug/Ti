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


test('collapseRange previews only an adjacent pair in one declaration block', () => {
  const code = '.card {\n  align-items: center;\n  justify-items: end;\n}';
  const selection = 'align-items: center;\n  justify-items: end;';
  const result = CSSShorthands.collapseRange('place-items', selection, code, code.indexOf('align-items'));
  assert.equal(result.ok, true);
  assert.equal(result.value, 'center end');
});

test('collapseRange rejects duplicate declarations and an existing shorthand', () => {
  const duplicate = '.card { align-items: center; justify-items: end; align-items: start; }';
  const selected = 'align-items: center; justify-items: end;';
  assert.equal(
    CSSShorthands.collapseRange('place-items', selected, duplicate, duplicate.indexOf('align-items')).ok,
    false
  );

  const existing = '.card { place-items: normal; align-items: center; justify-items: end; }';
  assert.equal(
    CSSShorthands.collapseRange('place-items', selected, existing, existing.indexOf('align-items')).ok,
    false
  );
});

test('collapseRange rejects non-adjacent declarations and values invalid for a component', () => {
  const separated = '.card { align-items: center; gap: 1rem; justify-items: end; }';
  assert.equal(
    CSSShorthands.collapseRange('place-items', 'align-items: center; gap: 1rem; justify-items: end;', separated, separated.indexOf('align-items')).ok,
    false
  );

  const invalid = '.card { align-items: left; justify-items: center; }';
  assert.equal(
    CSSShorthands.collapseRange('place-items', 'align-items: left; justify-items: center;', invalid, invalid.indexOf('align-items')).ok,
    false
  );
});

test('component value validation is specific to each longhand property', () => {
  assert.equal(CSSShorthands.isAllowed('place-items', 0, 'left'), false);
  assert.equal(CSSShorthands.isAllowed('place-items', 1, 'left'), true);
  assert.equal(CSSShorthands.isAllowed('place-content', 0, 'flex-start'), true);
  assert.equal(CSSShorthands.isAllowed('place-content', 1, 'flex-start'), true);
  assert.equal(CSSShorthands.isAllowed('place-self', 0, 'auto'), true);
  assert.equal(CSSShorthands.isAllowed('place-self', 1, 'auto'), true);
});
