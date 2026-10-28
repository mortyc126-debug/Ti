const address = "https://example.com/";

console.log(address.at(-1));
console.log(address.at(-1) === "/" ? "слэш на конце есть" : "слэша нет");
console.log("".at(-1));
