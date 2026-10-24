function saveWithTimeout(key, value, timeoutMs = 300000) {
  sessionStorage.setItem(key, JSON.stringify(value));
  setTimeout(() => {
    sessionStorage.removeItem(key);
  }, timeoutMs);
}

// Пример:
saveWithTimeout('tempData', { count: 10 }, 5 * 60 * 1000); // Удаление через 5 минут