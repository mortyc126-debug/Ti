const адреса = ["/api/один", "/api/два", "/api/три"];

const ответы = await Promise.all(
  адреса.map(адрес => fetch(адрес).then(ответ => ответ.json()))
);
console.log(ответы.length);
