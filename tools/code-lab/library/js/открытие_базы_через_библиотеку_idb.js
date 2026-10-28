import { openDB } from "idb";

const db = await openDB("магазин", 1, {
  upgrade(база) {
    база.createObjectStore("items", { keyPath: "id" });
  },
});
