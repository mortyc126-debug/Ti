const locale = "ru";
console.log(new Intl.DisplayNames(locale, { type: "region" }).of("DE"));
console.log(new Intl.DisplayNames(locale, { type: "language" }).of("en"));
