const пакет = Buffer.alloc(4);
пакет.writeUInt32BE(305419896, 0);

console.log(пакет);
