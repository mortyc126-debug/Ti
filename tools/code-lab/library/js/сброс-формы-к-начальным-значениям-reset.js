document.body.innerHTML = '<form id="profile"><input name="city" value="Москва"><input name="note"></form>';
const form = document.querySelector("#profile");

form.elements.city.value = "Лиссабон";
form.elements.note.value = "заметка";
console.log(form.elements.city.value, form.elements.note.value);

form.reset();
console.log(form.elements.city.value, JSON.stringify(form.elements.note.value));
