function timeSplit(values, testSize) {
  const cut = values.length - testSize;
  return { train: values.slice(0, cut), test: values.slice(cut) };
}
console.log(timeSplit([1, 2, 3, 4, 5], 2));
