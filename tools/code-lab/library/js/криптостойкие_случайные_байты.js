const байты = crypto.getRandomValues(new Uint8Array(16));
const строка = [...байты].map(число => число.toString(16).padStart(2, "0")).join("");

console.log(байты.length);
console.log(строка.length);
