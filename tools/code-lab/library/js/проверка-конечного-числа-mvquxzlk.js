// Проверка конечного числа
// Группа: Проверка чисел
// Описание: Проверяет, что значение является конечным числом.
// Ожидаемый вывод: true; false; false; true
// Пояснения:
//   Number.isFinite — true только для конечных чисел типа number.
//   NaN — специальное значение, обозначающее нечисловой результат.

console.log(Number.isFinite(12.5)); // true
console.log(Number.isFinite(Infinity)); // false
console.log(Number.isFinite(NaN)); // false
console.log(Number.isNaN(NaN)); // true
