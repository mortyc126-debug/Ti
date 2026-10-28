const sound = new Audio("sounds/click.mp3");

const playButton = document.createElement("button");
playButton.textContent = "Играть";
document.body.append(playButton);

sound.volume = 0.5;

playButton.addEventListener("click", () => {
  sound.play();
  console.log(`Громкость: ${sound.volume}`);
});
