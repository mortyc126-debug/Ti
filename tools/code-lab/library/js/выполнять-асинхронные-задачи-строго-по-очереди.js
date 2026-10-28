function createSerialQueue() {
  let tail = Promise.resolve();
  return function enqueue(task) {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
}
const enqueue = createSerialQueue();
// const a = enqueue(() => saveFirst());
// const b = enqueue(() => saveSecond()); // начнётся после a
