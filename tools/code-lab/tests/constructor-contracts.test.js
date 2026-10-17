const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const file = path.resolve(__dirname, '../public/constructor.js');
const source = fs.readFileSync(file, 'utf8');
const start = source.indexOf('const BLOCK_CONTRACTS = {');
const runtimeStart = source.indexOf('const runtimeState = {');
const end = source.indexOf('\n\nconst CATS =', start);
assert(start >= 0 && end > start, 'contract section not found');

const context = {
  console,
  BLOCKS: {
    array: { label: 'массив' }, bars: { label: 'столбики' }, map: { label: 'map' },
    filter: { label: 'filter' }, reduce: { label: 'reduce' }, calc: { label: 'расчёт' },
    let: { label: 'переменная' }, object: { label: 'объект' }, log: { label: 'лог' },
    iff: { label: 'если' }, fetchj: { label: 'fetch' }, raw: { label: 'свой код' }
  },
  graph: { nodes: [], edges: [] },
  byId(id) { return this.graph.nodes.find(n => n.id === id); },
  nodeLabel(n) { return context.BLOCKS[n.blockId]?.label || n.blockId; },
  String, Map, Set, RegExp
};
vm.createContext(context);
vm.runInContext(source.slice(runtimeStart, end) + '\nthis.testApi={BLOCK_CONTRACTS,IDENTIFIER_RE,DECLARATION_RE,buildSymbols,edgeCheck,outputType,typeCompatible,runtimeAnalyze,runtimeCheckDocument,runtimeLibraryNeeds,dependencyStatus,DEPENDENCY_REGISTRY};', context);
const api = context.testApi;
const node = (blockId, fields) => ({ id: blockId, blockId, fields: fields || {} });

assert(api.IDENTIFIER_RE.test('числа'));
assert(api.IDENTIFIER_RE.test('сумма_2026'));
assert(!api.IDENTIFIER_RE.test('123числа'));

const symbols = api.buildSymbols('const числа = [1, 2]; let цена = 10; const имя = "x";');
assert.strictEqual(symbols.get('числа'), 'array');
assert.strictEqual(symbols.get('цена'), 'number');
assert.strictEqual(symbols.get('имя'), 'string');

const array = node('array', { name: 'числа' });
const bars = node('bars', { values: 'числа' });
const number = node('let', { name: 'x', value: '10' });
const object = node('object', { name: 'obj', body: 'a: 1' });
const map = node('map', { name: 'out', list: 'числа' });

assert.strictEqual(api.edgeCheck(array, bars).ok, true, 'array -> bars must be compatible');
assert.strictEqual(api.edgeCheck(array, map).ok, true, 'array -> map must be compatible');
assert.strictEqual(api.edgeCheck(number, bars).ok, false, 'number -> bars must be rejected');
assert.strictEqual(api.edgeCheck(object, map).ok, false, 'object -> map must be rejected');
assert.strictEqual(api.edgeCheck(node('log', { value: 'x' }), map).ok, false, 'void -> map must be rejected');


const runtime = api.runtimeAnalyze('const xs=[1,2]; const el=document.querySelector("#c"); console.log("hello");');
assert(runtime.selectors.includes('#c'), 'runtime selector must be detected');
assert(!runtime.external.includes('hello'), 'strings must not be treated as external identifiers');
const doc = { querySelector(sel){ return sel === '#c' ? {} : null; }, defaultView: {} };
const checked = api.runtimeCheckDocument(doc, 'document.querySelector("#c");');
assert.strictEqual(checked.errors.length, 0, 'existing DOM selector must pass runtime check');
const missing = api.runtimeCheckDocument(doc, 'document.querySelector("#missing");');
assert(missing.errors.some(x => x.includes('#missing')), 'missing DOM selector must fail runtime check');
const lib = api.runtimeCheckDocument(doc, 'XLSX.utils.book_new();');
assert(lib.errors.some(x => x.includes('XLSX')), 'missing library must fail runtime check');


const deps = api.runtimeLibraryNeeds('XLSX.read(data); import { create } from "zustand";');
assert(deps.some(x => x.id === 'sheetjs' && x.mode === 'script'), 'SheetJS dependency must be detected');
assert(deps.some(x => x.id === 'zustand' && x.mode === 'module'), 'Zustand ESM dependency must be detected');
const depDoc = { defaultView: { XLSX: {} } };
const depStatus = api.dependencyStatus(depDoc, 'XLSX.read(data); Chart.defaults;');
assert(depStatus.ready.some(x => x.id === 'sheetjs'), 'available SheetJS global must be ready');
assert(depStatus.missing.some(x => x.id === 'chartjs'), 'missing Chart.js global must be reported');

console.log('✓ constructor contracts/runtime/dependencies: all tests passed');
