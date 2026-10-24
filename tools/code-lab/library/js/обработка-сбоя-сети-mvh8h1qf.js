try {
  const response = await fetch('/api/data');
  if (!response.ok) throw new Error(response.status);
  console.log(await response.json());
} catch (error) {
  console.error('Не получилось загрузить:', error.message);
}