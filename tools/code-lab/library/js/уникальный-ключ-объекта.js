const ключ = Symbol("id");
const запись = { [ключ]: 42, имя: "Ада" };
console.log(запись[ключ]);
console.log(Object.keys(запись));
