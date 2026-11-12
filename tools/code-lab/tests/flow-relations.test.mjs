import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CODE_RELATIONS, edgeType, relationById, relationColor } = require('../public/relations.js');

test('flow edge type uses canonical type before legacy fields', () => {
  assert.equal(edgeType({ type: 'calls', rel: 'depends', kind: 'sequence' }), 'calls');
  assert.equal(edgeType({ type: '', rel: 'depends', kind: 'sequence' }), 'depends');
  assert.equal(edgeType({ kind: 'sequence' }), 'sequence');
});

test('flow edge without an explicit type remains a data edge', () => {
  assert.equal(edgeType({ from: 'a', to: 'b' }), 'data');
  assert.equal(edgeType(null), 'data');
});

test('edge types and colors use the shared CODE_RELATIONS registry', () => {
  const ids = new Set(CODE_RELATIONS.map(item => item.id));
  assert.ok(ids.has('data'));
  assert.ok(ids.has('sequence'));
  assert.equal(relationColor('sequence'), relationById('sequence').color);
  assert.equal(relationColor('unknown-type'), relationById('data').color);
});
