if (!response.ok) {
  document.querySelector('#error').textContent = 'Не удалось отправить форму';
  return;
}