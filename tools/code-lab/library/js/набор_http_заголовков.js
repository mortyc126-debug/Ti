const заголовки = new Headers({ accept: "application/json" });
заголовки.append("x-token", "123");

console.log(заголовки.get("Accept"));
console.log(заголовки.has("x-token"));
