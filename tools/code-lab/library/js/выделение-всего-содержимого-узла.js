const element = document.createElement("p");
element.textContent = "Привет, мир";
document.body.append(element);

const range = document.createRange();
range.selectNodeContents(element);
console.log(range.toString());
console.log(range.collapsed);
