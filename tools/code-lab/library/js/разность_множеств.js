const все = new Set([1, 2, 3]);
const выполненные = new Set([2]);

const осталось = все.difference(выполненные);
console.log([...осталось]);
