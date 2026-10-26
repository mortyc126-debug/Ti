async function runDag(tasks) {
  const graph = new Map(tasks.map(task => [task.id, task.dependsOn ?? []]));
  const state = new Map(), order = [], path = [];
  function visit(id) {
    if (!graph.has(id)) throw new Error(`Unknown dependency: ${id}`);
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new Error(`Dependency cycle: ${[...path, id].join(' -> ')}`);
    state.set(id, 1); path.push(id);
    for (const dependency of graph.get(id)) visit(dependency);
    path.pop(); state.set(id, 2); order.push(id);
  }
  for (const id of graph.keys()) visit(id);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const results = new Map();
  for (const id of order) {
    const task = byId.get(id);
    const dependencyResults = Object.fromEntries((task.dependsOn ?? []).map(dep => [dep, results.get(dep)]));
    results.set(id, await task.run(dependencyResults));
  }
  return results;
}
// tasks: [{ id: 'a', dependsOn: [], run: async () => value }, ...]
// Example: await runDag([{id:'a', dependsOn:[], run:async()=>2}, {id:'b', dependsOn:['a'], run:async d=>d.a+3}]);
