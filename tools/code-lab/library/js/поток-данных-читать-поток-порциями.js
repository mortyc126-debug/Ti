const reader = response.body.getReader();
const части = [];
try {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    части.push(value);
  }
} finally { reader.releaseLock(); }
