async function executeIfValid(input, validators, execute) {
  const errors = validators.map(validate => validate(input)).filter(Boolean);
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: await execute(input) };
}
// const result = await executeIfValid(payload, [validateShape, validatePermissions], saveRecord);
