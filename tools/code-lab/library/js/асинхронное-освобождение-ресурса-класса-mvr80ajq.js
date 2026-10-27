class Подключение {
  async [Symbol.asyncDispose]() {
    console.log("подключение закрыто");
  }
}

async function работа() {
  await using связь = acquireAsync();
  console.log("работаем");
}

function acquireAsync() { return new Подключение(); }
await работа();