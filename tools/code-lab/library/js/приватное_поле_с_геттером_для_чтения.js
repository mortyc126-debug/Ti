class Температура {
  #градусы;

  constructor(градусы) {
    this.#градусы = градусы;
  }

  get значение() {
    return this.#градусы;
  }
}

const сейчас = new Температура(21);
console.log(сейчас.значение);
try {
  сейчас.значение = 30;
} catch (ошибка) {
  console.log(ошибка.name);
}
