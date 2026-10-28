const текст = "Дата: 2026-10";
const { year: год, month: месяц } = текст.match(/(?<year>\d{4})-(?<month>\d{2})/u)?.groups ?? {};

console.log(год, месяц);
