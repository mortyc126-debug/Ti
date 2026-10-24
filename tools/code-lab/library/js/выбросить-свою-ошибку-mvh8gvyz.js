function divide(a, b) {
  if (b === 0) {
    throw new Error('Делить на ноль нельзя');
  }
  return a / b;
}