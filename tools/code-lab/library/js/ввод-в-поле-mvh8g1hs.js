const input = document.querySelector('#search');

input.addEventListener('input', (event) => {
  console.log(event.target.value);
});