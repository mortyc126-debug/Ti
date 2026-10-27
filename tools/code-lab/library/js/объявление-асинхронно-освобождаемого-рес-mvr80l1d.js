function открытьСессию(имя) {
  return {
    имя,
    async [Symbol.asyncDispose]() {
      await new Promise(пауза => setTimeout(пауза, 10));
      console.log("закрыта", имя);
    },
  };
}

try {
  await using сессия = открытьСессию("A");
  throw new Error("сбой");
} catch (ошибка) {
  console.log(ошибка.message);
}