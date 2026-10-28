async function runTimedSteps(input, steps, now = () => performance.now()) {
  const timings = [];
  let value = input;
  for (const step of steps) {
    const started = now();
    try {
      value = await step.run(value);
      timings.push({ name: step.name, durationMs: now() - started, ok: true });
    } catch (cause) {
      timings.push({ name: step.name, durationMs: now() - started, ok: false });
      throw Object.assign(new Error(`Этап «${step.name}» завершился ошибкой`), { cause, timings });
    }
  }
  return { value, timings };
}
// const result = await runTimedSteps(raw, [{name:'parse',run:parse}, {name:'normalize',run:normalize}]);
