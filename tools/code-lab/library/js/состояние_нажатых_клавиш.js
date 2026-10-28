const нажатые = new Set();

addEventListener("keydown", событие => нажатые.add(событие.code));
addEventListener("keyup", событие => нажатые.delete(событие.code));
addEventListener("blur", () => нажатые.clear());

function обновить() {
  if (нажатые.has("ArrowLeft")) console.log("влево");
}
