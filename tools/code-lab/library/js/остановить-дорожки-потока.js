const canvas = document.createElement("canvas");
const stream = canvas.captureStream(15);

console.log(stream.getTracks().map(track => track.readyState));

stream.getTracks().forEach(track => track.stop());

console.log(stream.getTracks().map(track => track.readyState));
