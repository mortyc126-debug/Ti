const { open, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

async function main() {
  const filePath = join(tmpdir(), "lines-demo.txt");
  await writeFile(filePath, "первая\nвторая\nтретья\n");

  const handle = await open(filePath);
  let number = 0;
  for await (const line of handle.readLines()) {
    number += 1;
    console.log(`${number}: ${line}`);
  }
}

main();
