const locale = "ru-RU";
const options = { dateStyle: "long", timeZone: "UTC" };
const date = new Date(Date.UTC(2024, 2, 15));
console.log(new Intl.DateTimeFormat(locale, options).format(date));
