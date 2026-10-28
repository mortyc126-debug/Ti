function validateFields(value, rules) {
  const errors = {};
  for (const [field, validators] of Object.entries(rules)) {
    const messages = validators.map(validate => validate(value[field], value)).filter(Boolean);
    if (messages.length) errors[field] = messages;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}
const result = validateFields({name:' ', age:-1}, {
  name: [v => typeof v === 'string' && v.trim() ? null : 'Имя обязательно'],
  age: [v => Number.isInteger(v) && v >= 0 ? null : 'Возраст должен быть неотрицательным целым']
});
console.log(result);
