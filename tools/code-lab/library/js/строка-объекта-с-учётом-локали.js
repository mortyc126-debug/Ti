const locale = "ru-RU";
console.log((1234567.891).toLocaleString(locale));
console.log(new Date(Date.UTC(2024, 2, 15)).toLocaleDateString(locale, { timeZone: "UTC" }));
console.log([1.5, 2000].toLocaleString(locale));
