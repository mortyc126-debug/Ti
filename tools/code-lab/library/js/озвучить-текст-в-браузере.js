const speakButton = document.createElement("button");
speakButton.textContent = "Озвучить";
document.body.append(speakButton);

speakButton.addEventListener("click", () => {
  const utterance = new SpeechSynthesisUtterance("Добро пожаловать!");
  utterance.lang = "ru-RU";
  speechSynthesis.speak(utterance);
});
