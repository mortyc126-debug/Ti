// конфиг.js содержит: export default { порт: 3000 };
const { default: конфигурация } = await import("./конфиг.js");

console.log(конфигурация.порт);
