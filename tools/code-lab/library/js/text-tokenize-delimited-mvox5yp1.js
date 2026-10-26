function parseDelimitedLine(line, delimiter = ',') {
  const fields = [];
  let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && quoted && line[i + 1] === '"') { value += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === delimiter && !quoted) { fields.push(value); value = ''; }
    else value += ch;
  }
  if (quoted) throw new Error('Незакрытая кавычка');
  fields.push(value);
  return fields;
}
console.log(parseDelimitedLine('a,"b,c","say ""hi"""'));
