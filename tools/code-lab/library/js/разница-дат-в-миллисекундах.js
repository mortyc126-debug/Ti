const start = new Date("2026-10-01T00:00:00Z");
const end = new Date("2026-10-26T00:00:00Z");
const days = (end - start) / 86_400_000;
console.log(days);
