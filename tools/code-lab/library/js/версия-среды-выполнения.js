console.log(process.version.startsWith("v"));
const [главная] = process.version.slice(1).split(".");
console.log(Number(главная) >= 18);
