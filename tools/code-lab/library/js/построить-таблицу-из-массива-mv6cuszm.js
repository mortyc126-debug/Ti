const colors = [
  { name: "Розовый", hex: "#FF006E" },
  { name: "Мятный", hex: "#52F2C9" }
];
const table = document.querySelector("#colors");
const body = table.querySelector("tbody");

colors.forEach(color => {
  const row = document.createElement("tr");
  const nameCell = document.createElement("td");
  const hexCell = document.createElement("td");

  nameCell.textContent = color.name;
  hexCell.textContent = color.hex;
  row.append(nameCell, hexCell);
  body.append(row);
});