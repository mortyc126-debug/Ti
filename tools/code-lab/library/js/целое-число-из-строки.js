const text = "42px";
console.log(parseInt(text, 10));
console.log(parseInt("  17 лет", 10));
console.log(parseInt("лет 17", 10));
console.log(Number.isNaN(parseInt("abc", 10)));
