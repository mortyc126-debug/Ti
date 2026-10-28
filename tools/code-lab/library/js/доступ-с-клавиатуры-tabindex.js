document.body.innerHTML = '<div id="plain">Обычный</div><div id="focusable">Фокусируемый</div>';
const plain = document.querySelector("#plain");
const focusable = document.querySelector("#focusable");

focusable.tabIndex = 0;

plain.focus();
console.log(document.activeElement === plain);
focusable.focus();
console.log(document.activeElement === focusable);
