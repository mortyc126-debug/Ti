const date = new Date("2026-10-26T12:00:00Z");
const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
console.log(fmt.format(date));
