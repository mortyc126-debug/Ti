const sound = new Audio("sounds/click.mp3");

const playButton = document.createElement("button");
playButton.textContent = "Играть";
document.body.append(playButton);

sound.loop = true;

playButton.addEventListener("click", () => sound.play());
