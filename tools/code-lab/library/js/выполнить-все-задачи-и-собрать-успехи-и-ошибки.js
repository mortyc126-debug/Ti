async function runAllSettled(tasks) {
  const results = await Promise.allSettled(tasks.map(task => Promise.resolve().then(task)));
  return {
    values: results.filter(x => x.status === 'fulfilled').map(x => x.value),
    errors: results.filter(x => x.status === 'rejected').map(x => x.reason),
    results
  };
}
// const report = await runAllSettled([() => loadA(), () => loadB()]);
