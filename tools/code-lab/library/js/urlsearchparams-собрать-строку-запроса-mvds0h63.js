const параметры = new URLSearchParams({ q: "ОФЗ", years: 5 });
const url = "https://example.com/search?" + параметры.toString();

console.log(url);
console.log(new URLSearchParams("a=1&b=2").get("b"));