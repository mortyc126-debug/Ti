function открытьБазу(имя) {
  return new Promise((разрешить, отклонить) => {
    const запрос = indexedDB.open(имя, 1);
    запрос.onupgradeneeded = () => {
      запрос.result.createObjectStore("items", { keyPath: "id" });
    };
    запрос.onsuccess = () => разрешить(запрос.result);
    запрос.onerror = () => отклонить(запрос.error);
  });
}

const db = await открытьБазу("магазин");
