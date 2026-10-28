async function fetchAllPages(fetchPage, { getItems = page => page.items, getNext = page => page.nextCursor, maxPages = 1000 } = {}) {
  const all = [];
  let cursor;
  for (let pageNo = 0; pageNo < maxPages; pageNo++) {
    const page = await fetchPage(cursor);
    all.push(...getItems(page));
    cursor = getNext(page);
    if (cursor == null || cursor === '') return all;
  }
  throw new Error(`Превышен лимит страниц: ${maxPages}`);
}
// const all = await fetchAllPages(cursor => api.list({cursor}));
