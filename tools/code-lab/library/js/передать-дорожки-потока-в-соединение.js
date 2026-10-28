const canvas = document.createElement("canvas");
const stream = canvas.captureStream(15);
const peer = new RTCPeerConnection();

stream.getTracks().forEach(track => peer.addTrack(track, stream));

console.log(`Отправителей: ${peer.getSenders().length}`);
