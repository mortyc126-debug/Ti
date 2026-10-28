const locale = "ru-RU";
const value = 1234;
console.log(new Intl.NumberFormat(locale, { notation: "compact" }).format(value));
console.log(new Intl.NumberFormat(locale, { notation: "compact" }).format(2500000));
