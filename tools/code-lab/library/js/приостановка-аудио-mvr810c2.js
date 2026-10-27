const звук = new AudioContext();
await звук.suspend();
console.log(звук.state);