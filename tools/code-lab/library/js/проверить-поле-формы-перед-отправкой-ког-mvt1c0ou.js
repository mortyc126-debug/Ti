form.elements.email.addEventListener('blur', event => {
  event.target.classList.toggle('invalid', !isEmail(event.target.value));
});