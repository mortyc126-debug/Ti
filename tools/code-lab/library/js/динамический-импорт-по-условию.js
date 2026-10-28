async function открытьИнструмент() {
  const module = await import("./tools.js");
  module.start();
}
