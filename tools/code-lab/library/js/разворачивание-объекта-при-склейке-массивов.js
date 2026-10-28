const object = { length: 2, 0: "первый", 1: "второй" };
console.log([1].concat(object));
object[Symbol.isConcatSpreadable] = true;
console.log([1].concat(object));
