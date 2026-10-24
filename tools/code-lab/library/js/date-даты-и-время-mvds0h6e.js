const д = new Date(Date.UTC(2026, 9, 18));

console.log(д.getUTCFullYear(), д.getUTCMonth() + 1, д.getUTCDate());
console.log(д.toISOString().slice(0, 10));

const завтра = new Date(д.getTime() + 24 * 60 * 60 * 1000);
console.log(завтра.toISOString().slice(0, 10));