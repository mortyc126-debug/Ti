function createDisposer() {
  const cleanups = [];
  let disposed = false;
  return {
    add(cleanup) {
      if (disposed) { cleanup(); return () => {}; }
      cleanups.push(cleanup);
      return () => { const i = cleanups.indexOf(cleanup); if (i >= 0) cleanups.splice(i, 1); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    }
  };
}
const disposer = createDisposer();
// disposer.add(() => window.removeEventListener('resize', handler));
