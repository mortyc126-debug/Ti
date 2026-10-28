function parseColor(text) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text);
  if (!match) {
    throw new SyntaxError(`Ожидался цвет вида #rrggbb, получено: ${text}`);
  }
  return match.slice(1).map(part => parseInt(part, 16));
}

console.log(parseColor("#ff8800"));

try {
  parseColor("#12");
} catch (error) {
  console.log(error.name, "-", error.message);
}
