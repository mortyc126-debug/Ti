const button = document.querySelector("#save");
button.setAttribute("aria-label", "Сохранить цвет");
button.setAttribute("data-state", "ready");
console.log(button.getAttribute("data-state"));