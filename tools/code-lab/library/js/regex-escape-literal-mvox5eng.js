const буквальныйТекст = "цена (USD) + налог?";
const безопасный = RegExp.escape(буквальныйТекст);
console.log(new RegExp(безопасный).test(буквальныйТекст));
