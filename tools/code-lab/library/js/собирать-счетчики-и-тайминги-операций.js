function createMetrics() {
  const counters = new Map(), timings = new Map();
  return {
    increment(name, amount = 1) { counters.set(name, (counters.get(name) ?? 0) + amount); },
    observe(name, milliseconds) {
      const values = timings.get(name) ?? { count: 0, total: 0, max: 0 };
      values.count++; values.total += milliseconds; values.max = Math.max(values.max, milliseconds); timings.set(name, values);
    },
    snapshot() {
      return { counters: Object.fromEntries(counters), timings: Object.fromEntries([...timings].map(([name, x]) => [name, { ...x, mean: x.total / x.count }])) };
    }
  };
}
const metrics = createMetrics(); metrics.increment('request.ok'); metrics.observe('request.ms', 12);
