function createWindowDeduper(windowMs, now = Date.now) {
  const seen = new Map();
  return function accept(key) {
    const time = now();
    for (const [oldKey, timestamp] of seen) if (time - timestamp >= windowMs) seen.delete(oldKey);
    if (seen.has(key)) return false;
    seen.set(key, time);
    return true;
  };
}
const acceptEvent = createWindowDeduper(5000);
// if (acceptEvent(event.id)) handle(event);
