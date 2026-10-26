function* все() {
  yield "начало";
  yield* [1, 2];
  yield "конец";
}
console.log([...все()]);
