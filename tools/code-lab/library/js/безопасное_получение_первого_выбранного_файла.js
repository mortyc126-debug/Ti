const поле = document.querySelector("input[type=file]");

поле.addEventListener("change", () => {
  const файл = поле.files?.[0];
  if (!файл) return;
  console.log(файл.name, файл.size);
});
