const peer = { // вместо настоящего RTCPeerConnection
  connectionState: "connected",
  close() { this.connectionState = "closed"; }
};
console.log(peer.connectionState);
peer.close();
console.log(peer.connectionState);
