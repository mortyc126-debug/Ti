const form = document.querySelector('form');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await fetch('/send', { method: 'POST', body: new FormData(form) });
});