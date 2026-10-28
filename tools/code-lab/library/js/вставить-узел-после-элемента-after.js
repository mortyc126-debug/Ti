document.body.innerHTML = "<ul><li id='first'>Хлеб</li><li>Сыр</li></ul>";
const first = document.querySelector("#first");

const milk = document.createElement("li");
milk.textContent = "Молоко";
first.after(milk);

console.log([...document.querySelectorAll("li")].map(item => item.textContent).join(", "));
