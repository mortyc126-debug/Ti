const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 5000);

const response = await fetch('/api/data', { signal: controller.signal });
clearTimeout(timer);