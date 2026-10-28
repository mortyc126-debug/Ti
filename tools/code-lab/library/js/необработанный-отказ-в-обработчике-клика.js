async function run() {
  throw new Error("Сервер недоступен");
}

function handleError(error) {
  console.log(`Не удалось сохранить: ${error.message}`);
}

const saveButton = document.createElement("button");
saveButton.textContent = "Сохранить";
document.body.append(saveButton);

saveButton.addEventListener("click", () => {
  run().catch(handleError);
});
