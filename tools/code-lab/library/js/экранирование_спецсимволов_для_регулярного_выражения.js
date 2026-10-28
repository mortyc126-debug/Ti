const текст = "цена (руб.) *";
const escaped = текст.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

console.log(escaped);
console.log(new RegExp(escaped).test(текст));
