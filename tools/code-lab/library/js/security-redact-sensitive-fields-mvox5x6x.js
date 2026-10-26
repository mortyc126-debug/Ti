function redact(value, sensitiveKeys = ['password', 'token', 'secret', 'authorization']) {
  if (Array.isArray(value)) return value.map(item => redact(item, sensitiveKeys));
  if (!value || typeof value !== 'object') return value;
  const blocked = new Set(sensitiveKeys.map(key => key.toLowerCase()));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, blocked.has(key.toLowerCase()) ? '[REDACTED]' : redact(item, sensitiveKeys)
  ]));
}
console.log(redact({user:'A', token:'abc'}));
