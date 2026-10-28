async function загрузитьКонфиг() {
  return { порт: 3000 };
}

const конфиг = await загрузитьКонфиг();
console.log(конфиг.порт);
