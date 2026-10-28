const память = process.memoryUsage();
console.log(Object.keys(память).includes("rss"));
console.log(память.heapUsed > 0);
