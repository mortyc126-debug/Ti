const dropzone = document.createElement("div");
dropzone.textContent = "Бросьте файлы сюда";
dropzone.style.padding = "40px";
document.body.append(dropzone);

dropzone.addEventListener("dragover", event => event.preventDefault());
dropzone.addEventListener("drop", event => {
  event.preventDefault();
  const files = [...event.dataTransfer.files];
  console.log(`Получено файлов: ${files.length}`);
  for (const file of files) console.log(`${file.name}, ${file.size} байт`);
});
