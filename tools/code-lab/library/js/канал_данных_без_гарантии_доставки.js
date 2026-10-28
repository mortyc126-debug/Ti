const соединение = new RTCPeerConnection();
const канал = соединение.createDataChannel("chat", { ordered: false, maxRetransmits: 0 });

console.log(канал.label, канал.ordered);
