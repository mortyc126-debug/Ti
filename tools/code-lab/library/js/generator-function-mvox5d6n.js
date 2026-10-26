function* диапазон(старт, конец) {
  for (let i = старт; i <= конец; i++) yield i;
}
console.log([...диапазон(2, 4)]);
