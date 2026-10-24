const fs = require('fs/promises');

async function main() {
  const text = await fs.readFile('data.txt', 'utf-8');
  console.log(text);
}

main();