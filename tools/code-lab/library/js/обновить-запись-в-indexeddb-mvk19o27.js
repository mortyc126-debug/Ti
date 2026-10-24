async function updateItem(db, item) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('items', 'readwrite');
    const store = transaction.objectStore('items');

    const request = store.put(item);

    request.onsuccess = () => resolve(item);
    request.onerror = () => reject('Ошибка при обновлении записи');
  });
}

// Пример использования:
initDB()
  .then(db => updateItem(db, { id: 2, name: 'Обновлённые Данные' }))
  .then(() => getAllItems(db))
  .then(items => console.log('Обновлённые записи:', items))
  .catch(err => console.error(err));