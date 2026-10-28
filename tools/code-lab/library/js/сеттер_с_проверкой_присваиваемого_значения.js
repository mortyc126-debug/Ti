class Профиль {
  #имя = "";

  get имя() {
    return this.#имя;
  }

  set имя(новое) {
    if (!новое.trim()) throw new Error("Имя не может быть пустым");
    this.#имя = новое.trim();
  }
}

const профиль = new Профиль();
профиль.имя = "  Мира ";
console.log(профиль.имя);
try {
  профиль.имя = "   ";
} catch (ошибка) {
  console.log(ошибка.message);
}
