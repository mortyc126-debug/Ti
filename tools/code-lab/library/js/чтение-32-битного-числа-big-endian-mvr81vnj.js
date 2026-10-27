const пакет = Buffer.from([0x00, 0x00, 0x01, 0x00]);
const длина = пакет.readUInt32BE(0);

console.log(длина);