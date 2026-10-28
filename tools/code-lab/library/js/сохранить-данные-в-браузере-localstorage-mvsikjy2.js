const raw = localStorage.getItem('settings');
const settings = raw ? JSON.parse(raw) : { theme: 'light', fontSize: 14 };