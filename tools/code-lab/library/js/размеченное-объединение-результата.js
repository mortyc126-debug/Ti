/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, error: Error }} Result
 */

/**
 * @param {string} text
 * @returns {Result<number>}
 */
function parseAge(text) {
  const age = Number(text);
  if (!Number.isInteger(age) || age < 0) {
    return { ok: false, error: new Error(`Некорректный возраст: ${text}`) };
  }
  return { ok: true, value: age };
}

for (const input of ["42", "abc"]) {
  const result = parseAge(input);
  if (result.ok) {
    console.log("Возраст:", result.value);
  } else {
    console.log("Ошибка:", result.error.message);
  }
}
