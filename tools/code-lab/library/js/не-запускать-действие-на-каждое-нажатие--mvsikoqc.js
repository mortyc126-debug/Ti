const onInput = debounce(event => {
  console.log('Ищем:', event.target.value);
}, delay);
input.addEventListener('input', onInput);