performance.mark("начало");
performance.mark("конец");
performance.measure("работа", "начало", "конец");
const замеры = performance.getEntriesByType("measure");
console.log(замеры.map(замер => замер.name));
