function createCircuitBreaker(task, { failureThreshold = 3, cooldownMs = 5000, now = Date.now } = {}) {
  let failures = 0, openUntil = 0;
  return async (...args) => {
    if (now() < openUntil) throw new Error('Circuit breaker открыт');
    try {
      const result = await task(...args);
      failures = 0; openUntil = 0;
      return result;
    } catch (error) {
      failures++;
      if (failures >= failureThreshold) openUntil = now() + cooldownMs;
      throw error;
    }
  };
}
// const safeRequest = createCircuitBreaker(requestJson, { failureThreshold: 3, cooldownMs: 5000 });
