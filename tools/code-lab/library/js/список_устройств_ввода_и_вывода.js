const устройства = await navigator.mediaDevices.enumerateDevices();
const микрофоны = устройства.filter(устройство => устройство.kind === "audioinput");

console.log(микрофоны.map(микрофон => микрофон.label || "(без названия)"));
