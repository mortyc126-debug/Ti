const formData = new FormData();

formData.append("title", "Заметка");
formData.append("tag", "js");
formData.append("tag", "css");

console.log(formData.get("title"));
console.log(formData.getAll("tag").join(", "));
