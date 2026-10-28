const button = document.createElement("button");
document.body.append(button);

button.addEventListener("click", () => console.log("клик"));
button.addEventListener("focus", () => console.log("фокус"));

console.log(Object.keys(getEventListeners(button)).join(", "));
console.log(getEventListeners(button).click.length);
