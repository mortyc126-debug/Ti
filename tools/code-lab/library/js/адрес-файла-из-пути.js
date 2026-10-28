const { pathToFileURL } = require("node:url");
const адрес = pathToFileURL("/home/анна/мой отчёт.txt");
console.log(адрес.protocol);
console.log(адрес.href);
