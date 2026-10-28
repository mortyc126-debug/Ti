const emptyModule = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const wrongVersion = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]);
const randomBytes = new Uint8Array([1, 2, 3, 4]);

console.log(WebAssembly.validate(emptyModule));
console.log(WebAssembly.validate(wrongVersion));
console.log(WebAssembly.validate(randomBytes));
