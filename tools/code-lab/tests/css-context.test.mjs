import test from 'node:test';
import assert from 'node:assert/strict';
import CSSContext from '../public/css-context.js';

const atEnd = code => ({
  code,
  cursor: (() => {
    const lines = code.split(/\r?\n/);
    return { line: lines.length - 1, ch: lines.at(-1).length };
  })(),
});

test('CSS value context identifies the property and token prefix', () => {
  const result = CSSContext.resolve(atEnd('.card { align-items: en'));
  assert.equal(result.kind, 'css-value');
  assert.equal(result.expected, 'property-value');
  assert.equal(result.property, 'align-items');
  assert.equal(result.prefix, 'en');
  assert.deepEqual(result.constraints, { property: 'align-items', declarationBlock: true });
});

test('CSS value context works across lines and after previous declarations', () => {
  const result = CSSContext.resolve(atEnd('.card {\n  display: grid;\n  justify-content: space-'));
  assert.equal(result.kind, 'css-value');
  assert.equal(result.property, 'justify-content');
  assert.equal(result.prefix, 'space-');
});

test('CSS comments suppress ordinary autocomplete', () => {
  const code = '.card { /* align-items: en */ color: red; }';
  const result = CSSContext.resolve({ code, cursor: { line: 0, ch: code.indexOf('en') + 2 } });
  assert.equal(result.kind, 'css-comment');
  assert.equal(result.suppressAutocomplete, true);
});

test('CSS strings suppress ordinary code autocomplete', () => {
  const result = CSSContext.resolve(atEnd('.card { content: "hello'));
  assert.equal(result.kind, 'css-string');
  assert.equal(result.expected, 'string-content');
  assert.equal(result.inString, true);
  assert.equal(result.suppressAutocomplete, true);
});

test('CSS function context identifies function and argument index', () => {
  const result = CSSContext.resolve(atEnd('.card { transform: translate(10px, ce'));
  assert.equal(result.kind, 'css-function-argument');
  assert.equal(result.functionName, 'translate');
  assert.equal(result.argumentIndex, 1);
  assert.equal(result.prefix, 'ce');
});

test('CSS distinguishes property-name and selector positions', () => {
  const property = CSSContext.resolve(atEnd('.card { dis'));
  const selector = CSSContext.resolve(atEnd('main .card'));
  assert.equal(property.kind, 'css-property');
  assert.equal(property.expected, 'property-name');
  assert.equal(property.prefix, 'dis');
  assert.equal(selector.kind, 'css-selector');
  assert.equal(selector.expected, 'selector');
});
