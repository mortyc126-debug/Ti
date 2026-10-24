const field = document.querySelector("#amount");
const output = document.querySelector("#amountOutput");

field.addEventListener("input", () => {
  const amount = Number(field.value);
  output.textContent = Number.isFinite(amount) ? amount * 2 : "Введите число";
});