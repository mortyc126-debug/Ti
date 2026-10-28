function createJsonStorage(storage = localStorage) {
  return {
    read(key, fallback = null) {
      try { const raw = storage.getItem(key); return raw === null ? fallback : JSON.parse(raw); }
      catch { return fallback; }
    },
    write(key, value) {
      try { storage.setItem(key, JSON.stringify(value)); return true; }
      catch { return false; }
    },
    remove(key) { try { storage.removeItem(key); return true; } catch { return false; } }
  };
}
// const settings = createJsonStorage().read('settings', {});
