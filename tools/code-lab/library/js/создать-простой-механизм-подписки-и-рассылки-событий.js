function createEventBus() {
  const listeners = new Map();
  return {
    on(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
      return () => listeners.get(type)?.delete(handler);
    },
    emit(type, payload) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(payload);
    },
    clear(type) { type === undefined ? listeners.clear() : listeners.delete(type); }
  };
}
const bus = createEventBus();
const off = bus.on('updated', data => console.log(data)); bus.emit('updated', {id:1}); off();
