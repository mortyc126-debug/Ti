const saved = { version: 1, payload: { count: 3 } };
const payload = saved.version === 1 ? saved.payload : null;
console.log(payload?.count ?? 0);
