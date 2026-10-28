const { readFile } = require("node:fs/promises");

async function readOptional(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function main() {
  console.log(await readOptional("/нет/такого/файла.txt"));
  const ownText = await readOptional(__filename);
  console.log(typeof ownText);
}

main();
