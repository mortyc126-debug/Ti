const заголовок = Buffer.from("PNG:");
const тело = Buffer.from([1, 2, 3]);

const пакет = Buffer.concat([заголовок, тело]);
console.log(пакет.length);
