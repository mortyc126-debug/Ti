function readSettings(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    console.error("Ошибка чтения настроек:", error.name);
    throw error;
  }
}

try {
  readSettings("{");
} catch (error) {
  console.log("Верхний уровень поймал:", error.name);
}
