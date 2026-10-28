const notes = "Встреча 12.03, показ 25.04, отчёт до 01.06";
const dateRegex = /(\d{2})\.(\d{2})/g;

let match;
while ((match = dateRegex.exec(notes)) !== null) {
  console.log(`день ${match[1]}, месяц ${match[2]}`);
}
