const value = { имя: "Анна" };
module.exports = value;
console.log(module.exports === value);
console.log(require.cache[__filename].exports === value);
