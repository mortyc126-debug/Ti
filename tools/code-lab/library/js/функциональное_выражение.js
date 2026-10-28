const приветствие = function (имя) {
  return `Привет, ${имя}!`;
};

const факториал = function считать(n) {
  return n <= 1 ? 1 : n * считать(n - 1);
};

console.log(приветствие("Мира"));
console.log(факториал(5));
