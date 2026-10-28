const канал = {
  async *[Symbol.asyncIterator]() {
    for (let номер = 1; номер <= 3; номер++) {
      await new Promise(пауза => setTimeout(пауза, 5));
      yield номер;
    }
  },
};

for await (const сообщение of канал) {
  console.log(сообщение);
}
