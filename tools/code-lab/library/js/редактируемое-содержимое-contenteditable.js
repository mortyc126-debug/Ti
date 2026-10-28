const note = document.createElement("div");
note.textContent = "Нажмите и редактируйте";
note.contentEditable = "true";
document.body.append(note);

console.log(note.isContentEditable);
console.log(note.getAttribute("contenteditable"));
