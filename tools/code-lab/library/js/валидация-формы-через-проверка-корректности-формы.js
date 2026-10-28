const form = document.querySelector("form");
if (form.checkValidity()) {
  console.log("Можно отправлять");
} else {
  form.reportValidity();
}
