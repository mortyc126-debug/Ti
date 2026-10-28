if (!response.ok) {
  throw new Error(`Сервер ответил ${response.status}`);
}