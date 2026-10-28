async function withCleanup(run, cleanup) {
  try { return await run(); }
  finally { await cleanup(); }
}
// await withCleanup(() => runTest(), () => removeTempFiles());
