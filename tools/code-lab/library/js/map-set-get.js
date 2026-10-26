const кэш = new Map();
const ключ = { id: 1 };
кэш.set(ключ, "готово");
console.log(кэш.get(ключ));
console.log(кэш.has(ключ));
