const letters = ["а", "б", "в", "г", "д", "е", "ж", "з", "и", "к"];
const step = 3;

for (let i = 0; i < letters.length; i += step) {
  console.log(`${i}: ${letters[i]}`);
}
