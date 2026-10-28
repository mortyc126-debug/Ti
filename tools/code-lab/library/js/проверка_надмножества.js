const большое = new Set([1, 2, 3]);
const малое = new Set([1, 2]);
console.log([...малое].every(x => большое.has(x)));
