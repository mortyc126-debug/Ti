class Источник {
  async *сообщения() {
    yield "первое";
    await new Promise(пауза => setTimeout(пауза, 10));
    yield "второе";
  }
}

for await (const текст of new Источник().сообщения()) {
  console.log(текст);
}
