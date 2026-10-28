async function загрузитьПользователя() {
  return { имя: "Мира", возраст: 30 };
}

/** @type {Awaited<ReturnType<typeof загрузитьПользователя>>} */
const пользователь = { имя: "Лев", возраст: 25 };

console.log(пользователь.имя);
