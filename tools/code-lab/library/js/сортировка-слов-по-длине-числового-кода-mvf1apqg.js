// words — твой словарь (сюда приходит массив слов)
const words = ["кот", "яма", "сон", "эра", "ухо", "лев", "дом"];

const alphabet = "абвгдеёжзийклмнопрстуфхцчшщъыьэюя";
const vowels   = "аеёиоуыэюя";

const isLetter  = ch => alphabet.includes(ch);
const letterNum = ch => alphabet.indexOf(ch) + 1;                 // а→1 … я→33
const digitsOf  = w => [...w.toLowerCase()].filter(isLetter).map(letterNum).join("");

function fits(w){                                                 // ровно 2 согласные и 1 гласная
  const letters = [...w.toLowerCase()].filter(isLetter);
  const v = letters.filter(c => vowels.includes(c)).length;
  return v === 1 && (letters.length - v) === 2;
}

const result = words
  .filter(fits)
  .sort((a, b) => digitsOf(a).length - digitsOf(b).length
               || digitsOf(a).localeCompare(digitsOf(b)));

console.log(result);