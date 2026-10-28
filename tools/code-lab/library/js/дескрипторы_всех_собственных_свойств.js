const исходный = {
  get сумма() {
    return 3;
  },
  имя: "а",
};

const точная = Object.defineProperties({}, Object.getOwnPropertyDescriptors(исходный));
const обычная = { ...исходный };

console.log(typeof Object.getOwnPropertyDescriptor(точная, "сумма").get);
console.log(typeof Object.getOwnPropertyDescriptor(обычная, "сумма").get);
