const card = document.createElement("div");
card.textContent = "Карточка";
card.draggable = true;
document.body.append(card);

card.addEventListener("dragstart", event => {
  event.dataTransfer.effectAllowed = "move";
  console.log(`Разрешено: ${event.dataTransfer.effectAllowed}`);
});
