/**
 * @param {unknown} input
 * @returns {input is string}
 */
function isString(input) {
  return typeof input === "string";
}

for (const item of ["текст", 42, null]) {
  console.log(isString(item) ? item.toUpperCase() : "не строка");
}
