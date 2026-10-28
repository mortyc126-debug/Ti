const контекст = new AudioContext();
const ответ = await fetch("/звуки/удар.mp3");
const буфер = await контекст.decodeAudioData(await ответ.arrayBuffer());

const источник = контекст.createBufferSource();
источник.buffer = буфер;
источник.connect(контекст.destination);
источник.start();
