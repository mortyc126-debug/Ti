const peer = new EventTarget(); // вместо настоящего RTCPeerConnection
const video = { srcObject: null }; // вместо элемента video
peer.addEventListener("track", event => { video.srcObject = event.streams[0] });

const приём = new Event("track");
приём.streams = ["поток собеседника"];
peer.dispatchEvent(приём);
console.log(video.srcObject);
