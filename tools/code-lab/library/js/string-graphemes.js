const сегментатор = new Intl.Segmenter("ru", { granularity: "grapheme" });
const символы = [...сегментатор.segment("A👩‍💻Б")].map(x => x.segment);
console.log(символы);
