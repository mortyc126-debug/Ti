const request = indexedDB.open("contacts", 1);

request.onupgradeneeded = () => {
  const store = request.result.createObjectStore("people", { keyPath: "id" });
  store.createIndex("byname", "name", { unique: false });
};

request.onsuccess = () => {
  const db = request.result;
  const writing = db.transaction("people", "readwrite");
  writing.objectStore("people").put({ id: 1, name: "Мира" });
  writing.objectStore("people").put({ id: 2, name: "Олег" });

  writing.oncomplete = () => {
    const search = db.transaction("people").objectStore("people").index("byname").get("Мира");
    search.onsuccess = () => console.log(search.result);
  };
};
