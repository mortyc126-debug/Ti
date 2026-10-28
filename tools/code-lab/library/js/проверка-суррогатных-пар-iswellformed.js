const goodText = "Привет 😀";
const brokenText = "abc\uD800";

console.log(goodText.isWellFormed());
console.log(brokenText.isWellFormed());
