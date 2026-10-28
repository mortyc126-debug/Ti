document.body.innerHTML = "<div>Один</div><div>Два</div><span>Три</span>";
const blocks = document.getElementsByTagName("div");

console.log(blocks.length);
document.body.append(document.createElement("div"));
console.log(blocks.length);
console.log([...blocks].map(block => block.tagName).join(" "));
