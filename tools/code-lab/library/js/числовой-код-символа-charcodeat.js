function shiftLetters(text, step) {
  let result = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const isLowerLatin = code >= 97 && code <= 122;
    result += isLowerLatin ? String.fromCharCode(((code - 97 + step) % 26) + 97) : text[index];
  }
  return result;
}

console.log("a".charCodeAt(0));
console.log(shiftLetters("hello, world", 3));
