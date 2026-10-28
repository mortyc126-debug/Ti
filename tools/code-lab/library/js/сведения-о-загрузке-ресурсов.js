const ресурсы = performance.getEntriesByType("resource");
console.log(Array.isArray(ресурсы));
console.log(ресурсы.map(запись => запись.name).slice(0, 3));
