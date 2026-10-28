function parseNormalizeValidate(raw, { parse = JSON.parse, normalize, validate }) {
  let value;
  try { value = parse(raw); } catch (error) { return { ok: false, stage: 'parse', errors: [error.message] }; }
  try { value = normalize(value); } catch (error) { return { ok: false, stage: 'normalize', errors: [error.message] }; }
  const errors = validate(value);
  return errors.length ? { ok: false, stage: 'validate', errors } : { ok: true, value };
}
// const result = parseNormalizeValidate(text, { normalize: cleanData, validate: checkData });
