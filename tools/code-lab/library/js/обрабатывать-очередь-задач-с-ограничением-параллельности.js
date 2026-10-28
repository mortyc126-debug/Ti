function createTaskQueue(concurrency = 2) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency должен быть >= 1');
  const waiting = [];
  let active = 0;
  function drain() {
    while (active < concurrency && waiting.length) {
      const { task, resolve, reject } = waiting.shift();
      active++;
      Promise.resolve().then(task).then(resolve, reject).finally(() => { active--; drain(); });
    }
  }
  return task => new Promise((resolve, reject) => { waiting.push({ task, resolve, reject }); drain(); });
}
const enqueueTask = createTaskQueue(3);
// const result = await enqueueTask(() => loadOne());
