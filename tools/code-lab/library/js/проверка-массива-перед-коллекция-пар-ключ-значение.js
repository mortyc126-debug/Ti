function namesOf(data) {
  if (!Array.isArray(data)) return [];
  return data.map(item => String(item.name ?? ""));
}
console.log(namesOf(null));
