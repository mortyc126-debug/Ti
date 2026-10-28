const locale = "ru-RU";
const value = 1234.5;
console.log(new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(value));
console.log(new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(value));
