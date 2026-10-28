document.body.innerHTML = '<p id="para">Текст<!--комментарий--></p>';
const para = document.querySelector("#para");

for (const node of [para, para.firstChild, para.lastChild, document]) {
  console.log(node.nodeName);
}
