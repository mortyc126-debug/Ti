const зона = document.querySelector("#зона");

зона.addEventListener("dragover", событие => событие.preventDefault());

зона.addEventListener("drop", событие => {
  событие.preventDefault();
  const id = событие.dataTransfer.getData("text/plain");
  console.log("Сброшен элемент", id);
});
