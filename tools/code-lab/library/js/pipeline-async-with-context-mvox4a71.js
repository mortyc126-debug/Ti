async function runPipeline(input, steps, context = {}) {
  let value = input;
  for (const step of steps) value = await step(value, context);
  return { value, context };
}
// const result = await runPipeline(raw, [parse, normalize, enrich], { requestId, strict: true });
