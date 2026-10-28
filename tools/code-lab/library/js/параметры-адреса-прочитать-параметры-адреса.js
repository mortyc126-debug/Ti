const params = new URLSearchParams(window.location.search);
const page = Number(params.get("page") ?? 1);
console.log(page);
