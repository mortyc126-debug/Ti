const форма = document.querySelector("form");
const данные = new FormData(форма);

for (const [имя, значение] of данные) {
  console.log(имя, значение);
}
