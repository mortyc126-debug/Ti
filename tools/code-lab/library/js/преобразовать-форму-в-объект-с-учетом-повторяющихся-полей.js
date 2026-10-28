function formToObject(form) {
  const result = {};
  for (const [key, value] of new FormData(form)) {
    if (Object.hasOwn(result, key)) result[key] = Array.isArray(result[key]) ? [...result[key], value] : [result[key], value];
    else result[key] = value;
  }
  return result;
}
// const payload = formToObject(document.querySelector('form'));
