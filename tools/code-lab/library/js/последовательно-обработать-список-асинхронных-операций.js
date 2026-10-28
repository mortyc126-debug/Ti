const результаты = [];
for (const id of [1, 2, 3]) {
  const значение = await получитьДанные(id);
  результаты.push(значение);
}
console.log(результаты);
