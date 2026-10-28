const pending = new Set();
function следить(promise) {
  pending.add(promise); promise.finally(() => pending.delete(promise));
  return promise;
}
const задача = следить(new Promise(выполнить => setTimeout(выполнить, 10)));
console.log(pending.size);
задача.then(() => console.log(pending.size));
