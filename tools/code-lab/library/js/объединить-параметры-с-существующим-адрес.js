function withQuery(url, params) {
  const parsed = new URL(url, typeof location !== 'undefined' ? location.href : 'http://localhost');
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parsed.searchParams.set(key, value === null ? '' : String(value));
  }
  return parsed;
}
console.log(withQuery('https://example.com/items?page=1', {page:2, q:'серебро'}).href);
