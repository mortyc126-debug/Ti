const поле = document.querySelector("input");

if (!поле.checkValidity()) {
  console.log(поле.validationMessage);
}
