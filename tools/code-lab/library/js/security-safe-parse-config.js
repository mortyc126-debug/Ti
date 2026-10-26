function parseConfig(input, defaults, allowedKeys = Object.keys(defaults)) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Конфигурация должна быть объектом');
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(input).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`Неизвестные параметры: ${unknown.join(', ')}`);
  return { ...defaults, ...input };
}
console.log(parseConfig({ retries: 2 }, { retries: 3, timeoutMs: 1000 }));
