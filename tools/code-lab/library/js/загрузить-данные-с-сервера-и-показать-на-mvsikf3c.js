const list = document.querySelector('#list');
for (const item of items) {
  const li = document.createElement('li');
  li.textContent = item.title;
  list.append(li);
}