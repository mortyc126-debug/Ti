const isNode = typeof process !== "undefined" && Boolean(process.versions?.node);

console.log(isNode ? "Код выполняется в Node.js" : "Код выполняется не в Node.js");
