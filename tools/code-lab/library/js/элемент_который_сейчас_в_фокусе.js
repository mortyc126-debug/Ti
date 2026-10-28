const элемент = document.activeElement;

if (элемент === document.body) {
  console.log("Ничего не в фокусе");
} else {
  console.log("В фокусе:", элемент.tagName);
}
