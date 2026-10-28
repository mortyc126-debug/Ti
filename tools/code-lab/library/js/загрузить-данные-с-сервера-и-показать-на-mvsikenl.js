const list = document.querySelector('#list');
list.innerHTML = items.map(item => `<li>${item.title}</li>`).join('');