class Клиент {
  async загрузить(номер) {
    await new Promise(пауза => setTimeout(пауза, 10));
    return { номер, статус: "готово" };
  }
}

const клиент = new Клиент();
console.log(await клиент.загрузить(7));
