const response = await fetch('/api/data');

if (!response.ok) {
  throw new Error('Ошибка сервера: ' + response.status);
}