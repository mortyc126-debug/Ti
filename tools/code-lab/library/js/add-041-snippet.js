const formatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 2, maximumFractionDigits: 2
});
console.log(formatter.format(12345.6));
