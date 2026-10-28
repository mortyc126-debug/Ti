document.body.innerHTML = '<ul id="list"><li>Старое</li></ul>';
const list = document.querySelector("#list");

const items = ["Хлеб", "Сыр"].map(name => {
  const item = document.createElement("li");
  item.textContent = name;
  return item;
});

list.replaceChildren(...items);
console.log(list.innerText.split("\n").join(", "));

list.replaceChildren();
console.log(list.children.length);
