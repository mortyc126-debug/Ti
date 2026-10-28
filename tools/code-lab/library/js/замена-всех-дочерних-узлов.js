const parent = document.createElement("ul");
parent.append(document.createElement("li"), document.createElement("li"));

const новые = ["яблоко", "груша", "слива"].map(название => {
  const элемент = document.createElement("li");
  элемент.textContent = название;
  return элемент;
});
parent.replaceChildren(...новые);
console.log(parent.children.length);

parent.replaceChildren();
console.log(parent.children.length);
