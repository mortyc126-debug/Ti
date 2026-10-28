const Color = Object.freeze({
  Red: 0,
  Green: 1,
  0: "Red",
  1: "Green",
});

console.log(Color.Green);
console.log(Color[Color.Green]);
console.log(Object.isFrozen(Color));
