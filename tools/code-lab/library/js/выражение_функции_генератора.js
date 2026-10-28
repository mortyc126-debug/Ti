const генератор = function* () {
  yield "а";
  yield "б";
};

console.log([...генератор()]);
