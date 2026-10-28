document.body.innerHTML = '<p id="text">Основной текст</p>';
const text = document.querySelector("#text");

const note = document.createElement("small");
note.textContent = "Примечание";
text.before(note);

console.log(document.body.innerHTML);
