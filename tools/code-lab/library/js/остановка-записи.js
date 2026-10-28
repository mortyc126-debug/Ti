const recorder = { // вместо настоящего MediaRecorder
  state: "recording",
  stop() { this.state = "inactive"; }
};
console.log(recorder.state);
recorder.stop();
console.log(recorder.state);
