function* weekdays() {
  yield "пн";
  yield "вт";
  yield "ср";
}

const days = weekdays();
console.log(days.next());
console.log([...weekdays()]);
