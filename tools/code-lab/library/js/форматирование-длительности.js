const locale = "ru";
if (typeof Intl.DurationFormat === "function") {
  console.log(new Intl.DurationFormat(locale, { style: "long" }).format({ hours: 1, minutes: 30 }));
} else {
  console.log("Intl.DurationFormat не поддерживается в этой среде");
}
