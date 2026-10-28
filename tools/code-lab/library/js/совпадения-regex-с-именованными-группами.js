const text = "2026-01-05 ERROR disk full\n2026-01-06 INFO ok\n2026-01-07 ERROR timeout";
const regex = /(?<date>\d{4}-\d{2}-\d{2}) ERROR (?<message>.+)/g;

const errors = [...text.matchAll(regex)].map(match => ({
  date: match.groups.date,
  message: match.groups.message,
}));

console.log(errors);
