import { readFile } from "node:fs/promises";

const байты = await readFile("module.wasm");
const { instance } = await WebAssembly.instantiate(байты);

console.log(Object.keys(instance.exports));
