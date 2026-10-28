const items = [42, true, null, undefined, [1, 2], { id: 1 }, Symbol("id")];

for (const item of items) {
  console.log(String(item));
}
