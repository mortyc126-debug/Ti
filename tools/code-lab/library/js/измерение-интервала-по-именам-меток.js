const name = "загрузка";
const startMark = "начало загрузки";
const endMark = "конец загрузки";
performance.mark(startMark);
performance.mark(endMark);
const замер = performance.measure(name, startMark, endMark);
console.log(замер.name, замер.entryType);
