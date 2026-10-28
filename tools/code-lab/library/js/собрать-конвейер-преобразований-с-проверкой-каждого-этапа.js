function createPipeline(steps) {
  return input => steps.reduce((value, step) => {
    const next = step.run(value);
    const error = step.validate?.(next);
    if (error) throw new Error(`${step.name}: ${error}`);
    return next;
  }, input);
}
const normalizeRecord = createPipeline([
  { name: 'trim', run: x => ({ ...x, name: x.name.trim() }) },
  { name: 'name-required', run: x => x, validate: x => x.name ? null : 'name пустой' }
]);
console.log(normalizeRecord({name:' A '}));
