const year = 2024;
const month = 1; // февраль: месяцы считаются от нуля
console.log(new Date(year, month + 1, 0).getDate());
console.log(new Date(2023, 1 + 1, 0).getDate());
