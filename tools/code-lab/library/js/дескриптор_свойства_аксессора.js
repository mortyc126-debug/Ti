const объект = {
  get сумма() {
    return 1 + 2;
  },
};

const дескриптор = Object.getOwnPropertyDescriptor(объект, "сумма");

console.log(typeof дескриптор.get, "value" in дескриптор);
