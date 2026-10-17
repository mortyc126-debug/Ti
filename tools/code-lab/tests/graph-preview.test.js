const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const file = path.resolve(__dirname, '../public/constructor.js');
const source = fs.readFileSync(file, 'utf8');

function extract(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert(start >= 0 && end > start, `section ${startText} not found`);
  return source.slice(start, end);
}

// Проверяем именно графовый порядок: зависимость должна выполняться раньше
// потребителя даже если координаты узлов стоят в обратном порядке.
{
  const graphStart = source.indexOf('const byPos =');
  const graphEnd = source.indexOf('\n// ── подсветка', graphStart);
  assert(graphStart >= 0 && graphEnd > graphStart);
  const context = {
    graph: { nodes: [], edges: [] },
    BLOCKS: {
      array: { code: f => `const ${f.name} = [${f.items}];`, type: 'leaf' },
      map: { code: f => `const ${f.name} = ${f.list}.map(x => ${f.expr});`, type: 'leaf' }
    }
  };
  context.byId = id => context.graph.nodes.find(n => n.id === id);
  context.nodeCode = nd => String(context.BLOCKS[nd.blockId].code(nd.fields));
  vm.createContext(context);
  vm.runInContext(source.slice(graphStart, graphEnd) + '\nthis.api={orderedNodes,currentCode};', context);

  const a = { id:'a', blockId:'array', fields:{name:'xs', items:'1,2'}, x:500, y:500 };
  const b = { id:'b', blockId:'map', fields:{name:'ys', list:'xs', expr:'x*2'}, x:10, y:10 };
  context.graph.nodes = [b, a];
  context.graph.edges = [{ from:'a', to:'b' }];
  const order = context.api.orderedNodes();
  assert.strictEqual(JSON.stringify(order.map(x => x.id)), JSON.stringify(['a', 'b']));
  assert(context.api.currentCode().indexOf('const xs') < context.api.currentCode().indexOf('const ys'));
}

// Проверяем сгенерированный Preview без браузера: ошибка rejected fetch
// должна дойти до parent.postMessage, а не исчезнуть внутри Promise.
{
  const start = source.indexOf('function buildPreviewHtml(');
  const end = source.indexOf('\nfunction run(){', start);
  assert(start >= 0 && end > start, 'buildPreviewHtml not found');
  const context = { JSON, String };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + '\nthis.buildPreviewHtml=buildPreviewHtml;', context);
  const html = context.buildPreviewHtml(
    'await fetch("/broken");',
    { libraries: [] },
    'run-42'
  );
  assert(html.includes('unhandledrejection'), 'Preview must install unhandledrejection handler');
  assert(html.includes('codeforge-preview-error'), 'Preview must report errors to parent');

  const script = html.match(/<script>([\s\S]*)<\\\/script>/);
  assert(script, 'Preview script must be extractable');
  const messages = [];
  const listeners = {};
  const ctx = {
    console,
    fetch: () => Promise.reject(new Error('network down')),
    parent: { postMessage: msg => messages.push(msg) },
    window: {
      addEventListener: (name, fn) => { listeners[name] = fn; }
    },
    document: {
      getElementById: () => ({ textContent: '' }),
      createElement: () => ({ set src(v){}, addEventListener(){}, set onload(v){ this._onload=v; }, set onerror(v){ this._onerror=v; } }),
      head: { appendChild(){} }
    },
    setTimeout, clearTimeout, Promise, Error, String, Array
  };
  vm.createContext(ctx);
  vm.runInContext(script[1], ctx);
  return Promise.resolve().then(() => new Promise(resolve => setTimeout(resolve, 0))).then(() => {
    assert(messages.some(m => m.type === 'codeforge-preview-error' && /network down/.test(m.message)), 'rejected fetch must be reported');
  });
}
