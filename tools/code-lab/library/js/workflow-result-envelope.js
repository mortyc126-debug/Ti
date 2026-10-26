const success = value => ({ ok: true, value, error: null });
const failure = (code, message, details = null) => ({ ok: false, value: null, error: { code, message, details } });
function unwrapResult(result) {
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, details: result.error.details });
  return result.value;
}
console.log(success({id:1}));
