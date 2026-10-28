const name = "этап загрузки";
const метка = performance.mark(name);
console.log(метка.name);
console.log(метка.entryType);
console.log(метка.startTime >= 0);
