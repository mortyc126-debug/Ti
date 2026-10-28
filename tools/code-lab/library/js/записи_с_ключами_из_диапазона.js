import { wrap } from "idb";

const запрос = indexedDB.open("магазин", 1);
запрос.onupgradeneeded = () => запрос.result.createObjectStore("товары");
const база = await wrap(запрос);
const хранилище = база.transaction("товары").objectStore("товары");

const от = "товар-1";
const до = "товар-5";
const найденные = await wrap(хранилище.getAll(IDBKeyRange.bound(от, до)));

console.log(найденные.length);
