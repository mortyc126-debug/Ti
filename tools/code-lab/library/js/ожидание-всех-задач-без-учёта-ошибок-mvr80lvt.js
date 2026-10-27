const задачи = [
  Promise.resolve("a"),
  Promise.reject(new Error("сбой")),
  Promise.resolve("c"),
];

const итоги = await Promise.all(задачи.map(задача => задача.catch(() => undefined)));
console.log(итоги);