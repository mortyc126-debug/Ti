const element = document.createElement("p");
element.textContent = "Привет, мир";
document.body.append(element);

const range = document.createRange();
range.setStart(element.firstChild, 0);
range.setEnd(element.firstChild, 8);
range.deleteContents();
console.log(element.textContent);
