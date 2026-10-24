const а = [1, 2];
const б = [...а, 3, 4];

const база = { тема: "тёмная", размер: 14 };
const настройки = { ...база, размер: 16 };

console.log(б);
console.log(JSON.stringify(настройки));