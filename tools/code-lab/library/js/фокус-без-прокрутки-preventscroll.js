document.body.innerHTML = '<div style="height: 3000px">Длинная страница</div><input id="field">';
const field = document.querySelector("#field");

field.focus({ preventScroll: true });

console.log(document.activeElement === field);
console.log(window.scrollY);
