const байты = new TextEncoder().encode("Привет");

console.log(байты.length);
console.log(байты instanceof Uint8Array);
