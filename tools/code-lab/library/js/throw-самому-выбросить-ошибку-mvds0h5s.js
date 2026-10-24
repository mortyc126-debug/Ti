function делить(a, b) {
  if (b === 0) {
    throw new Error("деление на ноль");
  }
  return a / b;
}

try {
  console.log(делить(6, 3));
  console.log(делить(1, 0));
} catch (e) {
  console.log("поймано:", e.message);
}