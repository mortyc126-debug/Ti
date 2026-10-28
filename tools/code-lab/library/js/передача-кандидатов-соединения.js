const peer = new EventTarget(); // вместо настоящего RTCPeerConnection
const отправлено = [];
function send(кандидат) {
  отправлено.push(кандидат.candidate);
}
peer.addEventListener("icecandidate", event => { if (event.candidate) send(event.candidate) });

const найден = new Event("icecandidate");
найден.candidate = { candidate: "кандидат-первый" };
peer.dispatchEvent(найден);

const конец = new Event("icecandidate");
конец.candidate = null;
peer.dispatchEvent(конец);
console.log(отправлено);
