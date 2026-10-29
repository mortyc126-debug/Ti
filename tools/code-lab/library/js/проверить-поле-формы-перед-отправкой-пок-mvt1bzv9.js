form.elements.email.addEventListener('input', event => {
  const ok = isEmail(event.target.value);
  event.target.classList.toggle('invalid', !ok);
});