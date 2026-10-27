import userEvent from "@testing-library/user-event";

document.body.innerHTML = "<button>Нажать</button>";
const кнопка = document.querySelector("button");
let нажатий = 0;
кнопка.addEventListener("click", () => нажатий++);

await userEvent.click(кнопка);
console.log(нажатий);