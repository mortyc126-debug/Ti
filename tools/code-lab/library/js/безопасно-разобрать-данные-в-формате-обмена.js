function разобратьJSON(текст) {
  try { return { ok: true, value: JSON.parse(текст) }; }
  catch (ошибка) { return { ok: false, error: ошибка.message }; }
}
console.log(разобратьJSON("{bad}" ).ok);
