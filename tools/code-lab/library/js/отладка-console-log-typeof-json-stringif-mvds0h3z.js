const цена = 100;
const данные = { цена };

console.log("цена =", цена);
console.log(typeof цена, typeof данные, Array.isArray([1]));
console.log(JSON.stringify(данные, null, 2));