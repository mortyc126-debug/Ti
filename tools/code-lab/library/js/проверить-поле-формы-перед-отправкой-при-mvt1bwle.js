form.addEventListener('submit', event => {
  if (!isEmail(form.elements.email.value)) {
    event.preventDefault();
  }
});