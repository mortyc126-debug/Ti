const settings = { theme: 'dark', size: 16 };
localStorage.setItem('settings', JSON.stringify(settings));

const saved = JSON.parse(localStorage.getItem('settings'));