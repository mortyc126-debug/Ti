function createSnapshot(state) {
  return JSON.stringify(state);
}
function restoreSnapshot(snapshot, validate = () => true) {
  const value = JSON.parse(snapshot);
  if (!validate(value)) throw new Error('Снимок не прошёл проверку');
  return value;
}
// const restored = restoreSnapshot(createSnapshot(state), isValidState);
