let settings;
try {
  settings = JSON.parse(localStorage.getItem('settings'));
} catch {
  settings = null;
}