import { open, writeFile, rm } from "node:fs/promises";

await writeFile("./данные.txt", "Привет");

const дескриптор = await open("./данные.txt", "r");
try {
  console.log(await дескриптор.readFile("utf8"));
} finally {
  await дескриптор.close();
}

await rm("./данные.txt");
