const sound = new Audio("sounds/click.mp3");

const playButton = document.createElement("button");
playButton.textContent = "Играть";
document.body.append(playButton);

playButton.addEventListener("click", () => {
  sound.currentTime = 0;
  sound.play();
});
