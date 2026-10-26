function parseLines(text, parseLine) {
  const values = [], errors = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try { values.push({ line: index + 1, value: parseLine(line, index + 1) }); }
    catch (error) { errors.push({ line: index + 1, text: line, message: error.message }); }
  });
  return { values, errors };
}
// const result = parseLines(fileText, line => JSON.parse(line));
