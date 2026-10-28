const host = document.createElement("div");
document.body.append(host);

const shadow = host.attachShadow({ mode: "open" });
const button = document.createElement("button");
shadow.append(button);

console.log(button.getRootNode() === shadow);
console.log(host.getRootNode() === document);
