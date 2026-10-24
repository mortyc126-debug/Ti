async function initDB() {
  return new Promise((resolve, reject) => {
    // Открываем или создаём базу
    const request = indexedDB.open('myDatabase', 1);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      // Создаём объектное хранилище
      if (!db.objectStoreNames.contains('items')) {
        db.createObjectStore('items', { keyPath: 'id' });
      }
    };

    request.onsuccess = (event) => {
      resolve(event.target.result); // Возвращаем открытую базу
    };

    request.onerror = (event) => {
      reject('Ошибка при открытии базы');
    };
  });
}

// Пример использования:
initDB()
  .then(db => console.log('База готова!'))
  .catch(err => console.error(err));