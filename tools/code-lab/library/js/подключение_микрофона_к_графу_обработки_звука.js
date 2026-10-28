const поток = await navigator.mediaDevices.getUserMedia({ audio: true });
const контекст = new AudioContext();

const вход = контекст.createMediaStreamSource(поток);
const анализатор = контекст.createAnalyser();
вход.connect(анализатор);
