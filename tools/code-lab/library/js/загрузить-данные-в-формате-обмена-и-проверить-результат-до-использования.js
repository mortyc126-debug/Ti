function parseAndValidateJson(text, validate) {
  let value;
  try { value = JSON.parse(text); }
  catch (error) { return { ok: false, stage: 'parse', errors: [error.message] }; }
  const errors = validate(value);
  return errors.length ? { ok: false, stage: 'validation', errors } : { ok: true, value };
}
// const result = parseAndValidateJson(text, validatePortfolio);
