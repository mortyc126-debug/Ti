const params = new URLSearchParams({ q: 'книги', page: 1 });
const response = await fetch(`/api/items?${params}`);