const основа = { приветствие() { return "привет"; } };
const источник = Object.create(
  основа,
  Object.getOwnPropertyDescriptors({ get сумма() { return 3; }, имя: "заказ" })
);

const клон = Object.create(
  Object.getPrototypeOf(источник),
  Object.getOwnPropertyDescriptors(источник)
);

console.log(клон.приветствие(), клон.сумма);
console.log(Object.getPrototypeOf(клон) === основа);
