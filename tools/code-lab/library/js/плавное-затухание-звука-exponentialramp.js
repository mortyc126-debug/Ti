const startButton = document.createElement("button");
startButton.textContent = "Звук";
document.body.append(startButton);

startButton.addEventListener("click", () => {
  const audio = new AudioContext();
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.connect(gain).connect(audio.destination);

  gain.gain.setValueAtTime(1, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.5);

  oscillator.start();
  oscillator.stop(audio.currentTime + 0.6);
});
