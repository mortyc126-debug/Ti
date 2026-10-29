document.querySelector('#list').addEventListener('click', event => {
  const item = event.target.closest('.item');
  if (item) console.log('Нажали на', item.dataset.id);
});