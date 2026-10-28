const ввод = "12.5";
const число = Number(ввод);
if (Number.isFinite(число)) {
  console.log(число);
} else {
  console.log("Некорректное число");
}
