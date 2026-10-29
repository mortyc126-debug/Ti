setInterval(() => {
  document.querySelector('#clock').textContent = new Date().toLocaleTimeString('ru-RU');
}, 1000);