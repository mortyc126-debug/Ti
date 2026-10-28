const locale = "ru-RU";
const options = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
const value = 1234567.891;
console.log(new Intl.NumberFormat(locale, options).format(value));
console.log(new Intl.NumberFormat("en-US", options).format(value));
