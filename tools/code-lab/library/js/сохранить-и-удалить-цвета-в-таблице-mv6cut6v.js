const storageKey = "palette";
let colors = JSON.parse(localStorage.getItem(storageKey) || "[]");

function saveColors() {
  localStorage.setItem(storageKey, JSON.stringify(colors));
}

function renderColors() {
  const body = document.querySelector("#colors tbody");
  body.replaceChildren();

  colors.forEach((color, index) => {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    const remove = document.createElement("button");

    cell.textContent = color;
    remove.textContent = "Удалить";
    remove.addEventListener("click", () => {
      colors.splice(index, 1);
      saveColors();
      renderColors();
    });

    row.append(cell, remove);
    body.append(row);
  });
}

function addColor(color) {
  colors.push(color);
  saveColors();
  renderColors();
}