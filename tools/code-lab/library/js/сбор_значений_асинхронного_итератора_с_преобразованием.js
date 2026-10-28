async function* источник() {
  yield 1;
  yield 2;
  yield 3;
}

const элементы = await Array.fromAsync(источник(), число => число * 2);
console.log(элементы);
