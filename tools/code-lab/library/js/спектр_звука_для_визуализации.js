const контекст = new AudioContext();
const анализатор = контекст.createAnalyser();
анализатор.fftSize = 256;

const данные = new Uint8Array(анализатор.frequencyBinCount);
анализатор.getByteFrequencyData(данные);

console.log(данные.length);
