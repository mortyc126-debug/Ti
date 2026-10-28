document.body.innerHTML = '<a id="link" href="/docs" target="_blank" rel="noopener">Документация</a>';
const link = document.querySelector("#link");

for (const attribute of link.attributes) {
  console.log(`${attribute.name} = ${attribute.value}`);
}
console.log(`Всего атрибутов: ${link.attributes.length}`);
