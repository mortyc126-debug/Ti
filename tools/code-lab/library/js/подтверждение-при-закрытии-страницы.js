let hasUnsavedText = false;

const noteField = document.createElement("textarea");
const saveButton = document.createElement("button");
saveButton.textContent = "Сохранить";
document.body.append(noteField, saveButton);

noteField.addEventListener("input", () => {
  hasUnsavedText = true;
});

saveButton.addEventListener("click", () => {
  hasUnsavedText = false;
});

window.addEventListener("beforeunload", event => {
  if (hasUnsavedText) event.preventDefault();
});
