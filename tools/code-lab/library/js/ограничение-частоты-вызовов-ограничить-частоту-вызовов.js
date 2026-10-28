function throttle(fn, delay) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= delay) { last = now; fn(...args); }
  };
}
const onMove = throttle(event => console.log(event.clientX), 100);
