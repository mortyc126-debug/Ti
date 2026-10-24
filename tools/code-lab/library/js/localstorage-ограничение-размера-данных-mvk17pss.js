function saveWithSizeLimit(key, value, maxSize = 4 * 1024 * 1024) {
  const jsonStr = JSON.stringify(value);
  if (jsonStr.length > maxSize) {
    // Обрезаем данные до лимита
    const truncated = jsonStr.substring(0, maxSize);
    console.warn(`Данные обрезаны до ${maxSize} байт`);
    localStorage.setItem(key, truncated);
  } else {
    localStorage.setItem(key, jsonStr);
  }
}

// Пример:
saveWithSizeLimit('bigData', { hugeArray: Array(100000).fill(1) });