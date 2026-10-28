document.body.innerHTML = '<button id="save" class="btn btn-loading">Сохранить</button>';
const saveButton = document.querySelector("#save");

console.log(saveButton.classList.replace("btn-loading", "btn-done"));
console.log(saveButton.className);
console.log(saveButton.classList.replace("btn-error", "btn-done"));
