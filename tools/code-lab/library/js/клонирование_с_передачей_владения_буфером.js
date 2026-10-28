const буфер = new ArrayBuffer(8);
const сообщение = { кадр: буфер };

const копия = structuredClone(сообщение, { transfer: [буфер] });

console.log(буфер.byteLength, копия.кадр.byteLength);
