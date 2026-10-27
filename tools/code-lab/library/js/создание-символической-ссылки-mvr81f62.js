import { symlink } from "node:fs/promises";

await symlink("./релизы/v2/app.js", "./текущая-версия.js");
console.log("Ссылка создана");