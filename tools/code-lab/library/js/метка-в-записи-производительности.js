performance.mark("start");
const метки = performance.getEntriesByName("start");
console.log(метки.length);
console.log(метки[0].entryType);
