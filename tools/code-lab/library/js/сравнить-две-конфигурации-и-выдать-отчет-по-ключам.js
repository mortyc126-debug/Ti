function diffConfig(before, after) {
  const added = {}, removed = {}, changed = {};
  for (const [key, value] of Object.entries(after)) {
    if (!Object.hasOwn(before, key)) added[key] = value;
    else if (!Object.is(before[key], value)) changed[key] = { before: before[key], after: value };
  }
  for (const [key, value] of Object.entries(before)) if (!Object.hasOwn(after, key)) removed[key] = value;
  return { added, removed, changed };
}
console.log(diffConfig({timeout:100, debug:false}, {timeout:200, mode:'fast'}));
