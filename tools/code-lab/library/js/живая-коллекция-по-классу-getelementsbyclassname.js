document.body.innerHTML = '<p class="note">Первая</p><p class="note">Вторая</p>';
const notes = document.getElementsByClassName("note");

console.log(notes.length);
document.body.insertAdjacentHTML("beforeend", '<p class="note">Третья</p>');
console.log(notes.length);
