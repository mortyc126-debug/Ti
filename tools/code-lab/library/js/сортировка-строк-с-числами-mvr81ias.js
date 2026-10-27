const сравнить = new Intl.Collator("ru", { numeric: true }).compare;
console.log(["файл10", "файл2", "файл1"].sort(сравнить));