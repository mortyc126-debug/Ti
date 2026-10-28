async function открытьОтчёт() {
  const модуль = await import("./report.js");
  return модуль.buildReport();
}
