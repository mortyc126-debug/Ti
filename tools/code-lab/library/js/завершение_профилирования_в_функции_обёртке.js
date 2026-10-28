function профилировать(метка, действие) {
  console.profile(метка);
  try {
    return действие();
  } finally {
    console.profileEnd(метка);
  }
}

профилировать("сортировка", () => [3, 1, 2].sort());
