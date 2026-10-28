import { openDB } from "idb";

const база = await openDB("магазин", 1);
const товар = await база.get("items", "товар-1");

console.log(товар);
