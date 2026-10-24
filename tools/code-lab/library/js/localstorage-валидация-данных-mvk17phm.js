function safeLoad(key, defaultValue = []) {
  const data = localStorage.getItem(key);
  try {
    // Проверяем, что данные — корректный JSON
    const parsed = JSON.parse(data || 'null');
    // Проверяем, что тип совпадает с ожидаемым (массив или объект)
    if (Array.isArray(parsed) || typeof parsed === 'object' && parsed !== null) {
      return parsed;
    }
  } catch (e) {
    // Если ошибка — возвращаем дефолтное значение
  }
  return defaultValue;
}

// Пример использования:
const myData = safeLoad('userSettings', []);