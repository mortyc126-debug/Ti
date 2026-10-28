function setPath(source, path, nextValue) {
  if (path.length === 0) return nextValue;
  const [key, ...rest] = path;
  const base = source != null && typeof source === 'object' ? source : {};
  return { ...base, [key]: setPath(base[key], rest, nextValue) };
}
const oldState = {user:{settings:{theme:'dark'}}};
const nextState = setPath(oldState, ['user','settings','theme'], 'light');
console.log(oldState.user.settings.theme, nextState.user.settings.theme);
