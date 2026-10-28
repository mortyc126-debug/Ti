const form = document.querySelector('form');
const data = new FormData();
data.append('email', form.elements.email.value);
data.append('name', form.elements.name.value);