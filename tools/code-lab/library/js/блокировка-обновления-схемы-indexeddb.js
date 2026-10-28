const request = indexedDB.open("notes", 2);

request.onblocked = () => {
  console.log("Закройте другие вкладки с этим приложением: они мешают обновить базу");
};

request.onupgradeneeded = () => {
  const db = request.result;
  if (!db.objectStoreNames.contains("items")) {
    db.createObjectStore("items", { keyPath: "id" });
  }
};

request.onsuccess = () => {
  console.log("База обновлена");
  request.result.close();
};
