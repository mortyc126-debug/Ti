document.body.innerHTML = '<form id="signup"><input name="email" value="mira@example.com"><input name="age" value="30"></form>';
const form = document.querySelector("#signup");

console.log(form.elements.email.value);
console.log(form.elements["age"].value);
console.log(form.elements.length);
