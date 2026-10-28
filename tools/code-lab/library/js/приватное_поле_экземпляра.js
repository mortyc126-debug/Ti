class Счётчик {
  #значение = 0;

  увеличить() {
    this.#значение += 1;
    return this.#значение;
  }
}

const счёт = new Счётчик();
console.log(счёт.увеличить());
console.log(счёт.увеличить());
console.log(Object.keys(счёт));
