const шаблон = /^[A-Z]{2}-\d{4}$/;
console.log(шаблон.test("AB-2048"));
console.log(шаблон.test("ab-2048"));
