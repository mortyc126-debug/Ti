const object = { адрес: { город: "Омск" } };
console.log(object?.адрес?.город);
console.log(object?.контакты?.телефон);
const пусто = undefined;
console.log(пусто?.property);
