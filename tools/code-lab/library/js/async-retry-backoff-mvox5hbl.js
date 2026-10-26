const пауза = мс => new Promise(resolve => setTimeout(resolve, мс));
async function повторить(операция, попыток = 3) {
  for (let i = 0; ; i++) {
    try { return await операция(); }
    catch (ошибка) {
      if (i >= попыток - 1) throw ошибка;
      await пауза(250 * 2 ** i);
    }
  }
}
