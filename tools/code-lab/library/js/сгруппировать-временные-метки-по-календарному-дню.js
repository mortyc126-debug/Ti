function groupByUtcDay(items, getTimestamp) {
  const groups = new Map();
  for (const item of items) {
    const timestamp = new Date(getTimestamp(item));
    if (!Number.isFinite(timestamp.getTime())) continue;
    const day = timestamp.toISOString().slice(0, 10);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(item);
  }
  return groups;
}
// const daily = groupByUtcDay(rows, row => row.timestamp);
