const метка = Symbol("метка");
const объект = { а: 1, [метка]: 2 };

const пары = Reflect.ownKeys(объект).map(ключ => [ключ, объект[ключ]]);
console.log(пары);
