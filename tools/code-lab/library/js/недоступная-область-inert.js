document.body.innerHTML = '<div id="background"><button id="action">Действие</button></div>';
const background = document.querySelector("#background");
const actionButton = document.querySelector("#action");

background.inert = true;
actionButton.focus();

console.log(background.inert);
console.log(document.activeElement === actionButton);
