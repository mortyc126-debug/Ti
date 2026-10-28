import { wrap } from "idb";

const запрос = indexedDB.open("магазин", 1);
запрос.onupgradeneeded = () => запрос.result.createObjectStore("товары");
const база = await wrap(запрос);

const хранилище = база.transaction("товары", "readwrite").objectStore("товары");
await wrap(хранилище.clear());

console.log(await wrap(хранилище.count()));
