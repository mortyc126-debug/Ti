async function requestJson(url, options) {
  let response;
  try { response = await fetch(url, options); }
  catch (cause) { throw Object.assign(new Error('Сетевая ошибка запроса'), { kind: 'network', cause }); }
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { kind: 'http', status: response.status });
  try { return await response.json(); }
  catch (cause) { throw Object.assign(new Error('Ответ не является корректным JSON'), { kind: 'parse', cause, status: response.status }); }
}
// const data = await requestJson('/api/items');
