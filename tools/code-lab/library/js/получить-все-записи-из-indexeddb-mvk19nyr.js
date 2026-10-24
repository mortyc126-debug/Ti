async function getAllItems(db) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('items', 'readonly');
    const store = transaction.objectStore('items');
    const items = [];

    const request = store.getAll();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject('Ошибка при чтении записей');
  });
}

// Пример использования:
initDB()
  .then(db => getAllItems(db))
  .then(items => console.log('Все записи:', items))
  .catch(err => console.error(err));