document.body.innerHTML = '<div id="panel">Панель настроек</div>';
const panel = document.querySelector("#panel");

function setVisible(visible) {
  panel.hidden = !visible;
}

setVisible(false);
console.log(panel.hidden, getComputedStyle(panel).display);

setVisible(true);
console.log(panel.hidden, getComputedStyle(panel).display);
