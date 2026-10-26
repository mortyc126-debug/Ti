const исходник = { список: [1, 2], дата: new Date("2025-01-01") };
const копия = structuredClone(исходник);
копия.список.push(3);
console.log(исходник.список.length, копия.список.length);
