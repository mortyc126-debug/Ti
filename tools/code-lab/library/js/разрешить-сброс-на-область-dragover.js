const dropzone = document.createElement("div");
dropzone.textContent = "Перетащите файл сюда";
Object.assign(dropzone.style, { padding: "40px", border: "2px dashed gray" });
document.body.append(dropzone);

dropzone.addEventListener("dragover", event => event.preventDefault());

const probe = new Event("dragover", { cancelable: true });
dropzone.dispatchEvent(probe);
console.log("Сброс разрешён:", probe.defaultPrevented);
