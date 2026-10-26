function parseJSON(text) {
  try { return JSON.parse(text); }
  catch (error) { console.error("Некорректный JSON:", error.message); return null; }
}
console.log(parseJSON("{bad}"));
