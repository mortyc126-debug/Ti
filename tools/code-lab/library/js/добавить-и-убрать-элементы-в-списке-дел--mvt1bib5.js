const button = document.createElement('button');
button.textContent = '×';
button.addEventListener('click', () => li.remove());
li.append(button);