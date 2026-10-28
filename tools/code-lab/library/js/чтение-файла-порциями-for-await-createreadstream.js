const { createReadStream, statSync } = require("node:fs");

async function main() {
  let total = 0;
  let chunks = 0;

  for await (const chunk of createReadStream(__filename, { highWaterMark: 64 })) {
    total += chunk.length;
    chunks += 1;
  }

  console.log(`Размер совпал: ${total === statSync(__filename).size}`);
  console.log(`Порций больше одной: ${chunks > 1}`);
}

main();
