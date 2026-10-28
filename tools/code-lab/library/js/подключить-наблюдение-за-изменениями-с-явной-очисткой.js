function observeElement(element, callback, options = { childList: true, subtree: true }) {
  const observer = new MutationObserver(callback);
  observer.observe(element, options);
  return () => observer.disconnect();
}
// const stopObserving = observeElement(root, records => handleMutations(records));
