const card = document.createElement("div");
card.draggable = true;
card.id = "card-7";
document.body.append(card);

card.addEventListener("dragstart", event => {
  event.dataTransfer.setData("text/plain", card.id);
  console.log(`Запомнили: ${event.dataTransfer.getData("text/plain")}`);
});
