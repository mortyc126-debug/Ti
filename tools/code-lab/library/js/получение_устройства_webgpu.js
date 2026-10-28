const адаптер = await navigator.gpu?.requestAdapter();
const устройство = await адаптер?.requestDevice();

if (!устройство) {
  console.log("WebGPU недоступен");
} else {
  устройство.lost.then(сведения => console.log("Устройство потеряно:", сведения.reason));
}
