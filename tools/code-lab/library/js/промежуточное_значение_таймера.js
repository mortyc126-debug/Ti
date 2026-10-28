console.time("загрузка");

for (let i = 0; i < 1e6; i++) {}
console.timeLog("загрузка", "этап 1");

for (let i = 0; i < 1e6; i++) {}
console.timeEnd("загрузка");
