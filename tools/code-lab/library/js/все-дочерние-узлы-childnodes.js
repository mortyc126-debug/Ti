document.body.innerHTML = '<p id="para">Привет, <b>Мира</b><!-- комментарий --></p>';
const para = document.querySelector("#para");

for (const node of para.childNodes) {
  console.log(node.nodeName);
}
console.log(`Узлов: ${para.childNodes.length}, элементов: ${para.children.length}`);
