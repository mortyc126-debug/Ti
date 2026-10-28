import { wrap } from "idb";

const запрос = indexedDB.open("магазин", 1);
запрос.onupgradeneeded = () => запрос.result.createObjectStore("товары");
const база = await wrap(запрос);

const хранилище = база.transaction("товары", "readwrite").objectStore("товары");
await wrap(хранилище.add({ название: "чай" }, "товар-1"));

try {
  await wrap(хранилище.add({ название: "кофе" }, "товар-1"));
} catch (ошибка) {
  console.log(ошибка.name);
}
