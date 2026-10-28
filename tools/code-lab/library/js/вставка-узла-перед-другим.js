const parent = document.createElement("ul");
const начало = document.createElement("li");
начало.textContent = "начало";
const конец = document.createElement("li");
конец.textContent = "конец";
parent.append(начало, конец);

const середина = document.createElement("li");
середина.textContent = "середина";
parent.insertBefore(середина, конец);
console.log(Array.from(parent.children, элемент => элемент.textContent));
