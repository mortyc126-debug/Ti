function topologicalSort(graph) {
  const state = new Map(), order = [], path = [];
  function visit(node) {
    if (state.get(node) === 2) return;
    if (state.get(node) === 1) throw new Error(`Цикл зависимостей: ${[...path, node].join(' -> ')}`);
    state.set(node, 1); path.push(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    path.pop(); state.set(node, 2); order.push(node);
  }
  for (const node of graph.keys()) visit(node);
  return order;
}
const graph = new Map([['build',['compile']], ['compile',['lint']], ['lint',[]]]);
console.log(topologicalSort(graph));
