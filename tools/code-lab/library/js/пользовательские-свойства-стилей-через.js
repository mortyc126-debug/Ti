document.documentElement.style.setProperty("--accent", "#9b6cff");
const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
console.log(accent);
