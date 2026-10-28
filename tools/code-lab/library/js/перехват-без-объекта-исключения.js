function isValidJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

console.log(isValidJson('{"a": 1}'));
console.log(isValidJson("{a: 1}"));
