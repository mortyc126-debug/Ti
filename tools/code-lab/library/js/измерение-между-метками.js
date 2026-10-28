performance.mark("start");
for (let шаг = 0; шаг < 100000; шаг++) { /* нагрузка */ }
performance.mark("end");
const замер = performance.measure("duration", "start", "end");
console.log(замер.name);
console.log(замер.duration >= 0);
