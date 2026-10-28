import { wrap } from "idb";

const запрос = indexedDB.open("магазин", 1);
запрос.onupgradeneeded = () => запрос.result.createObjectStore("товары");
const база = await wrap(запрос);
const хранилище = база.transaction("товары").objectStore("товары");

const записи = await wrap(хранилище.getAll());
console.log(записи.length);
