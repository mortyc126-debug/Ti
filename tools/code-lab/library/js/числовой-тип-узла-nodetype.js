document.body.innerHTML = '<p id="para">Привет, <b>Мира</b><!--c--></p>';
const para = document.querySelector("#para");
const names = { 1: "элемент", 3: "текст", 8: "комментарий", 9: "документ" };

for (const node of para.childNodes) {
  console.log(names[node.nodeType]);
}

const elements = [...para.childNodes].filter(node => node.nodeType === Node.ELEMENT_NODE);
console.log(elements.length);
