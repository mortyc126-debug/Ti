const буфер = new ArrayBuffer(8, { maxByteLength: 32 });
console.log(буфер.byteLength);

буфер.resize(16);
console.log(буфер.byteLength);