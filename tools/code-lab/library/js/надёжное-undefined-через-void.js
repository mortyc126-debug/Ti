function isMissing(input) {
  return input === void 0;
}

console.log(isMissing(undefined));
console.log(isMissing(0));

(function (undefined) {
  console.log(undefined, void 0);
})("подмена");
