const fs = require('fs/promises');

async function main() {
  await fs.writeFile('out.txt', 'Привет', 'utf-8');
}

main();