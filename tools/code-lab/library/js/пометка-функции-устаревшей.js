const util = require("node:util");

const oldSum = util.deprecate(
  (first, second) => first + second,
  "oldSum() устарела, используйте sum()",
  "DEP_OLD_SUM"
);

console.log(oldSum(2, 3));
console.log(oldSum(4, 5));
