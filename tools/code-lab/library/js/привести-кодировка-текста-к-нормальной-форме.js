const a = "é";
const b = "e\u0301";
console.log(a === b);
console.log(a.normalize("NFC") === b.normalize("NFC"));
