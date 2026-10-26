function parseFiniteNumber(input) {
  if (typeof input === 'string' && input.trim() === '') return { ok: false, error: 'empty' };
  const value = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(value)) return { ok: false, error: 'not-finite-number' };
  return { ok: true, value };
}
console.log(parseFiniteNumber('12.5'));
