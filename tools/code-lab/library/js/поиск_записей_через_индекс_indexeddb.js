import { wrap } from "idb";

const запрос = indexedDB.open("магазин", 1);
запрос.onupgradeneeded = () => {
  const хранилище = запрос.result.createObjectStore("товары", { keyPath: "id" });
  хранилище.createIndex("byname", "name");
};
const база = await wrap(запрос);

const хранилище = база.transaction("товары").objectStore("товары");
const найденные = await wrap(хранилище.index("byname").getAll("чай"));
console.log(найденные.length);
