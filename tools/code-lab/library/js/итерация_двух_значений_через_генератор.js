const пара = {
  *[Symbol.iterator]() {
    yield "первый";
    yield "второй";
  },
};

const [а, б] = пара;
console.log(а, б);
