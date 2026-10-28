const шаблон = new URLPattern({ pathname: "/users/:id" });
const id = шаблон.exec("https://example.com/users/42")?.pathname.groups.id;

console.log(id);
