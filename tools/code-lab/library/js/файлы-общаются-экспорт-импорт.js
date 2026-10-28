// ── файл  math.js  —  отдаёт функции наружу ──
export function среднее(список){
  return список.reduce((a, b) => a + b, 0) / список.length;
}
export const ВЕРСИЯ = "1.0";

// ── файл  main.js  —  берёт их у соседа ──
import { среднее, ВЕРСИЯ } from "./math.js";   // путь к файлу-соседу

console.log(среднее([10, 20, 30]));   // 20
console.log("версия:", ВЕРСИЯ);