const формат = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
console.log(формат.format(1234567.89));
