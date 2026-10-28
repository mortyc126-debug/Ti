const locale = "ru";
const items = ["яблоки", "груши", "сливы"];
console.log(new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items));
console.log(new Intl.ListFormat(locale, { type: "disjunction" }).format(items));
