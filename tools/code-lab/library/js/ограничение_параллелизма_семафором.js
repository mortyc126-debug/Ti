class Семафор {
  #свободно;
  #очередь = [];

  constructor(лимит) {
    this.#свободно = лимит;
  }

  async run(задача) {
    if (this.#свободно === 0) {
      await new Promise(разрешить => this.#очередь.push(разрешить));
    } else {
      this.#свободно--;
    }
    try {
      return await задача();
    } finally {
      const следующий = this.#очередь.shift();
      if (следующий) следующий();
      else this.#свободно++;
    }
  }
}

const семафор = new Семафор(2);
let активных = 0;
let максимум = 0;

const задачи = Array.from({ length: 5 }, (_, номер) => async () => {
  активных++;
  максимум = Math.max(максимум, активных);
  await new Promise(пауза => setTimeout(пауза, 10));
  активных--;
  return номер;
});

const результаты = await Promise.all(задачи.map(задача => семафор.run(задача)));
console.log(максимум, результаты);
