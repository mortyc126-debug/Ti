if (typeof globalThis.structuredClone === "function") {
  console.log("есть structuredClone");
} else {
  console.log("нужен другой способ копирования");
}
