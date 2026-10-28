const parent = document.createElement("ul");
for (const название of ["один", "два", "три"]) {
  const child = document.createElement("li");
  child.textContent = название;
  parent.append(child);
}
const удалённый = parent.removeChild(parent.children[1]);
console.log(удалённый.textContent);
console.log(Array.from(parent.children, элемент => элемент.textContent));
