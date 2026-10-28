const card = document.createElement("div");
card.textContent = "Карточка";
card.draggable = true;
document.body.append(card);

card.addEventListener("dragstart", () => console.log("Перетаскивание началось"));

console.log(card.draggable, card.getAttribute("draggable"));
