const saveButton = document.createElement("button");
saveButton.textContent = "Сохранить";
document.body.append(saveButton);

saveButton.addEventListener("click", event => {
  console.log("первый обработчик");
  event.stopImmediatePropagation();
});
saveButton.addEventListener("click", () => console.log("второй обработчик"));
document.addEventListener("click", () => console.log("документ"));
