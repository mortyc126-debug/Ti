const подключение = await new Promise((разрешить, отклонить) => {
  const запрос = indexedDB.open("магазин", 1);
  запрос.onupgradeneeded = () => запрос.result.createObjectStore("товары");
  запрос.onsuccess = () => разрешить(запрос.result);
  запрос.onerror = () => отклонить(запрос.error);
});

const операция = подключение.transaction("товары", "readwrite");
операция.objectStore("товары").put({ название: "чай" }, "товар-1");

await new Promise((разрешить, отклонить) => {
  операция.oncomplete = разрешить;
  операция.onerror = () => отклонить(операция.error);
  операция.onabort = () => отклонить(операция.error);
});
console.log("Транзакция зафиксирована");