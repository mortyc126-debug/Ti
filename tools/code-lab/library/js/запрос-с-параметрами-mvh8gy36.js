const url = new URL('https://api.example.com/search');
url.searchParams.set('q', 'кот');
url.searchParams.set('page', 2);

fetch(url);