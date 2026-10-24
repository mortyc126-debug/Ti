async function addItem(db, item) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('items', 'readwrite');
    const store = transaction.objectStore('items');

    const request = store.add(item);

    request.onsuccess = () => resolve(item);
    request.onerror = () => reject('Ошибка при добавлении записи');
  });
}

// Пример использования:
initDB()
  .then(db => addItem(db, { id: 3, name: 'Данные 3' }))
  .then(() => console.log('Запись добавлена!'))
  .catch(err => console.error(err));