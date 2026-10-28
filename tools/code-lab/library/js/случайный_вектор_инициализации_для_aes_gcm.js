const iv = crypto.getRandomValues(new Uint8Array(12));
const другой = crypto.getRandomValues(new Uint8Array(12));

console.log(iv.length);
console.log(iv.every((байт, i) => байт === другой[i]));
