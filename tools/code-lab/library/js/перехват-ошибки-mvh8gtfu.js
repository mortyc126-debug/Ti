try {
  JSON.parse('{ плохой json');
} catch (error) {
  console.error('Не удалось разобрать:', error.message);
}