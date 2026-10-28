const path = require("node:path");
const dir = "/home/анна";
const name = "отчёт";
const ext = ".txt";
console.log(path.format({ dir, name, ext }));
