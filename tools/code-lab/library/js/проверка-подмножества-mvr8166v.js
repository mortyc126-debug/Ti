const малое = new Set([1, 2]);
const большое = new Set([1, 2, 3]);
console.log([...малое].every(x => большое.has(x)));