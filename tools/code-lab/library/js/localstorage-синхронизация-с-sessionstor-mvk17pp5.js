function syncLocalToSession() {
  const localKeys = Object.keys(localStorage);
  localKeys.forEach(key => {
    try {
      const data = JSON.parse(localStorage.getItem(key));
      sessionStorage.setItem(key, JSON.stringify(data));
    } catch (e) {
      console.warn(`Не удалось скопировать ${key}`);
    }
  });
}

// Вызываем при загрузке страницы
window.addEventListener('load', syncLocalToSession);