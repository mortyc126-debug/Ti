async function runWithCompensation(steps) {
  const completed = [];
  try {
    for (const step of steps) {
      const result = await step.run();
      completed.push({ step, result });
    }
    return completed.map(x => x.result);
  } catch (cause) {
    const rollbackErrors = [];
    for (const item of completed.reverse()) {
      try { await item.step.compensate(item.result); }
      catch (error) { rollbackErrors.push({ step: item.step.name, error }); }
    }
    throw Object.assign(new Error('Последовательность не завершена'), { cause, rollbackErrors });
  }
}
// Каждый step: { name, run, compensate }
