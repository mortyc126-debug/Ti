const field = document.createElement("input");
document.body.append(field);

field.addEventListener("input", () => console.log(`Введено: ${field.value}`));

field.value = "Мира";
field.dispatchEvent(new Event("input", { bubbles: true }));
