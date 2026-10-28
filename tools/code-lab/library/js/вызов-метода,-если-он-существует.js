const object = { приветствие() { return "привет"; } };
console.log(object?.method?.());
console.log(object?.приветствие?.());
const пусто = null;
console.log(пусто?.приветствие?.());
