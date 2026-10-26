async function retry(operation, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try { return await operation(); }
    catch (error) { lastError = error; }
  }
  throw lastError;
}
