const locale = "ru";
const формат = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
console.log(формат.format(-1, "day"));
console.log(формат.format(1, "day"));
console.log(формат.format(-3, "hour"));
