function saveSafely(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

console.log(saveSafely("draft", { text: "Черновик письма" }));
