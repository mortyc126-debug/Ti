for (let number = 1; number <= 6; number += 1) {
  if (number === 2) {
    continue;
  }
  if (number === 5) {
    break;
  }
  console.log(number);
}