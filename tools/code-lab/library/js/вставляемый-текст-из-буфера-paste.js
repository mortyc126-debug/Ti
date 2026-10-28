const field = document.createElement("input");
document.body.append(field);

field.addEventListener("paste", event => {
  const text = event.clipboardData.getData("text");
  event.preventDefault();
  field.value = text.trim();
  console.log(`Вставлено: «${field.value}»`);
});
