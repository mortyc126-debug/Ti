function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (error) { console.error(error); return false; }
}
console.log(saveJSON("settings", { theme: "dark" }));
