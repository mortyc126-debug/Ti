function stringifySafe(value) {
  try { return JSON.stringify(value); }
  catch (error) { console.error("Не сериализуется:", error.message); return null; }
}
const cyclic = {}; cyclic.self = cyclic;
console.log(stringifySafe(cyclic));
