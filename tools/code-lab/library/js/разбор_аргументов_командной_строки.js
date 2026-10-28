import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  args: ["--name", "Мира", "файл.txt"],
  options: { name: { type: "string" } },
  allowPositionals: true,
});

console.log(values.name, positionals);
