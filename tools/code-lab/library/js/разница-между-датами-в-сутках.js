const a = new Date(Date.UTC(2024, 0, 1));
const b = new Date(Date.UTC(2024, 0, 31));
console.log(Math.round((b - a) / 86400000));
