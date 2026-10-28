const скрытыйКлюч = Symbol("служебное");
const объект = { [скрытыйКлюч]: true, обычный: 1 };
console.log(Object.getOwnPropertySymbols(объект).length);
