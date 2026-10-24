const form = document.querySelector('form');

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(form);
  console.log(Object.fromEntries(data));
});