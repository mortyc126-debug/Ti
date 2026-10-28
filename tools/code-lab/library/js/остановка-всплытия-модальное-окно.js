document.body.innerHTML = '<div id="backdrop"><div id="dialog">Окно <button id="ok">OK</button></div></div>';
const backdrop = document.querySelector("#backdrop");
const dialog = document.querySelector("#dialog");

backdrop.addEventListener("click", () => console.log("окно закрыто"));
dialog.addEventListener("click", event => {
  event.stopPropagation();
  console.log("клик внутри окна");
});
