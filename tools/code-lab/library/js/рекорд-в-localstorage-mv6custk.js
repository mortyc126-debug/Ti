const key = "bestScore";
const best = Number(localStorage.getItem(key) || 0);
const score = 125;

if (score > best) {
  localStorage.setItem(key, String(score));
}

console.log(Math.max(best, score));