const { watch, writeFile, mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

async function main() {
  const folder = await mkdtemp(join(tmpdir(), "watch-"));
  const controller = new AbortController();

  setTimeout(() => writeFile(join(folder, "note.txt"), "привет"), 100);
  setTimeout(() => controller.abort(), 600);

  try {
    for await (const event of watch(folder, { signal: controller.signal })) {
      console.log(event.eventType, event.filename);
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
    console.log("Наблюдение остановлено");
  }
}

main();
