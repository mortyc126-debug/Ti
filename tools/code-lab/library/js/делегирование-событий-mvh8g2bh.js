const list = document.querySelector('ul');

list.addEventListener('click', (event) => {
  const li = event.target.closest('li');
  if (li) li.classList.toggle('done');
});