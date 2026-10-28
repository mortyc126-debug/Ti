/**
 * @template T
 * @param {T} input
 * @returns {T}
 */
function identity(input) {
  return input;
}

console.log(identity(42), identity("строка"), identity([1, 2]));
