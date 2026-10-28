document.body.innerHTML = '<ul id="list"><li id="template"><b>Задача</b> без названия</li></ul>';
const list = document.querySelector("#list");
const template = document.querySelector("#template");

const deepCopy = template.cloneNode(true);
const shallowCopy = template.cloneNode(false);
console.log(deepCopy.childNodes.length, shallowCopy.childNodes.length);

deepCopy.removeAttribute("id");
list.append(deepCopy);
console.log(list.children.length);
