const url = new URL("https://example.com/search");
url.search = new URLSearchParams({ q: "нефть и газ", page: "2" });
console.log(url.toString());
