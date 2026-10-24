window.addEventListener("keydown", event => {
  if (event.key === "ArrowLeft") {
    console.log("Движение влево");
  }
});

window.addEventListener("keyup", event => {
  console.log("Клавишу отпустили:", event.key);
});