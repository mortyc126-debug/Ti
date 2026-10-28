const openHost = document.createElement("div");
const closedHost = document.createElement("div");
document.body.append(openHost, closedHost);

openHost.attachShadow({ mode: "open" }).innerHTML = "<p>Внутри</p>";
closedHost.attachShadow({ mode: "closed" });

console.log(openHost.shadowRoot.innerHTML);
console.log(closedHost.shadowRoot);
