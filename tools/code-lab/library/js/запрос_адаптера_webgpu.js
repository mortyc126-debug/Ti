const адаптер = await navigator.gpu?.requestAdapter();

if (!адаптер) {
  console.log("WebGPU не поддерживается");
} else {
  const устройство = await адаптер.requestDevice();
  console.log("Устройство готово:", устройство.label || "без имени");
}
