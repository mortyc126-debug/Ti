const key = "savedColors";
const colors = JSON.parse(localStorage.getItem(key) || "[]");

colors.push("#FF006E");
localStorage.setItem(key, JSON.stringify(colors));

console.log(colors.length);