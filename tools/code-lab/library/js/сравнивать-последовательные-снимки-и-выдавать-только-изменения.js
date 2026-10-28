function createChangeDetector(fields) {
  let previous = null;
  return next => {
    if (previous === null) { previous = next; return { initial: true, changes: {} }; }
    const changes = diffFields(previous, next, fields);
    previous = next;
    return { initial: false, changes };
  };
}
// const detect = createChangeDetector(['price','volume']);
