const rows = Array.from({ length: 50 }, (_, index) => `<div style="height: 30px">Строка ${index + 1}</div>`);
document.body.innerHTML = `<div id="list" style="height: 150px; overflow: auto">${rows.join("")}</div>`;
const list = document.querySelector("#list");

list.children[29].scrollIntoView({ behavior: "smooth", block: "nearest" });

setTimeout(() => console.log(`scrollTop = ${list.scrollTop}`), 1500);
