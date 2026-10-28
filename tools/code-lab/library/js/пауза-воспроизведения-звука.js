const sound = new Audio("sounds/click.mp3");

const playButton = document.createElement("button");
playButton.textContent = "Играть";
document.body.append(playButton);

playButton.addEventListener("click", () => {
  if (sound.paused) {
    sound.play();
    playButton.textContent = "Пауза";
  } else {
    sound.pause();
    playButton.textContent = "Играть";
  }
});
