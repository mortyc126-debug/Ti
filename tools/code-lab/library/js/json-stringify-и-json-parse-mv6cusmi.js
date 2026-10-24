const colors = ["#FF006E", "#52F2C9"];
const saved = JSON.stringify(colors);
const loaded = JSON.parse(saved);
console.log(loaded[0]);
console.log(loaded.length);