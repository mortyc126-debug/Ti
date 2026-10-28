const контекст = new AudioContext();
const осциллятор = контекст.createOscillator();
const громкость = контекст.createGain();

громкость.gain.value = 0.5;
осциллятор.connect(громкость).connect(контекст.destination);
осциллятор.start();
