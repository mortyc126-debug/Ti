function throttle(fn, intervalMs) {
  let lastRun = -Infinity;
  return (...args) => {
    const now = Date.now();
    if (now - lastRun < intervalMs) return;
    lastRun = now;
    return fn(...args);
  };
}
const onScroll = throttle(() => console.log('scroll'), 100);
