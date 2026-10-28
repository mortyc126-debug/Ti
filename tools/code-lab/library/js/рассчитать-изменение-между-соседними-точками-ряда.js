function changes(values) {
  return values.slice(1).map((current, i) => {
    const previous = values[i];
    return { previous, current, delta: current - previous, percent: previous === 0 ? null : (current - previous) / Math.abs(previous) * 100 };
  });
}
console.log(changes([100, 110, 99]));
