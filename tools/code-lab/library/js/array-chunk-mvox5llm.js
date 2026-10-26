function разбить(массив, размер) {
  if (!Number.isInteger(размер) || размер < 1) throw new RangeError("размер должен быть положительным целым");
  const части = [];
  for (let i = 0; i < массив.length; i += размер) части.push(массив.slice(i, i + размер));
  return части;
}
console.log(разбить([1, 2, 3, 4, 5], 2));
