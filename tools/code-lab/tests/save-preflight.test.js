const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const file = path.resolve(__dirname, '../public/constructor.js');
const source = fs.readFileSync(file, 'utf8');
const start = source.indexOf('function componentPreflight(');
const end = source.indexOf('\nfunction renderPreflight', start);
assert(start >= 0 && end > start, 'componentPreflight not found');

const context = {
  Set, String, Map, RegExp,
  BLOCK_GUIDES: {
    array: { needs: [] },
    map: { needs: [] },
    bars: { needs: [] },
    calc: { needs: [] },
    raw: { needs: [] }
  },
  BLOCKS: {
    array: { fields: [{k:'name'}, {k:'items'}] },
    map: { fields: [{k:'name'}, {k:'list'}, {k:'expr'}] },
    bars: { fields: [{k:'values'}] },
    calc: { fields: [{k:'name'}, {k:'expr'}] },
    raw: { fields: [{k:'code'}] }
  },
  IDENTIFIER_RE: /^[\p{ID_Start}_$][\p{ID_Continue}_$]*$/u,
  blockContract(nd){
    return {
      array:{output:'array',outputField:'name'},
      map:{input:'array',inputField:'list',output:'array',outputField:'name'},
      bars:{input:'array',inputField:'values',output:'void',inputMode:'expression',dom:['c']},
      calc:{input:'any',inputField:'expr',output:'any',outputField:'name',inputMode:'expression'},
      raw:{input:'any',output:'any',inputMode:'free',unknown:true}
    }[nd.blockId] || {output:'any'};
  },
  connectedIncoming(){ return []; },
  connectedOutgoing(){ return []; },
  edgeCheck(){ return {ok:true}; },
  nodeLabel(n){ return n.blockId; },
  buildSymbols(code){
    const m = new Map();
    for(const x of String(code).matchAll(/(?:const|let|var)\s+([\p{ID_Start}_$][\p{ID_Continue}_$]*)\s*=\s*([^;\n]+)/gu)){
      const e=x[2].trim();
      m.set(x[1], /^\[/.test(e) ? 'array' : /^\d/.test(e) ? 'number' : 'any');
    }
    return m;
  },
  dependencyStatus(_doc, code){
    if(/import[\s\S]*['"]zustand['"]/.test(code)) return {ready:[],missing:[],manual:[{name:'Zustand',mode:'module'}]};
    if(/XLSX/.test(code)) return {ready:[],missing:[{name:'SheetJS',mode:'script'}],manual:[]};
    return {ready:[],missing:[],manual:[]};
  },
  dependencyAdvice(d){ return `нужна среда для ${d.name}`; },
  runtimeAnalyze(){ return {external:[]}; },
  document:{querySelector(){return null;}}
};
vm.createContext(context);
vm.runInContext(source.slice(start,end) + '\nthis.componentPreflight = componentPreflight;', context);

const check = (blockId, fields, code) => context.componentPreflight({blockId, fields}, code);

let r = check('array', {name:'xs',items:'1,2'}, 'const xs = [1,2];');
assert.strictEqual(r.errors.length, 0, 'valid array component must pass');

r = check('array', {name:'xs',items:'1,2'}, 'const xs = [1,2');
assert(r.errors.some(x => x.includes('Синтаксическая ошибка')), 'syntax error must block save');

r = check('map', {name:'out',list:'missing',expr:'x*2'}, 'const out = missing.map(x => x*2);');
assert(r.errors.some(x => x.includes('Переменная «missing» не объявлена')), 'missing input variable must block save');

r = check('bars', {values:'xs'}, 'const xs=[1,2];');
assert.strictEqual(r.errors.length, 0, 'registered script dependency absence must not falsely block save');

r = check('raw', {code:'import {create} from "zustand";'}, 'import {create} from "zustand";');
assert(r.errors.some(x => x.includes('Zustand')), 'unsupported ESM dependency must block save');

r = check('calc', {name:'result',expr:'missing + 1'}, 'const result = missing + 1;');
assert(r.errors.some(x => x.includes('Переменная «missing»')), 'undeclared calc variable must block save');

console.log('✓ save preflight: all tests passed');
