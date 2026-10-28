function представиться(приветствие) {
  return приветствие + ", я " + this.имя;
}
const fn = представиться;
const thisArg = { имя: "Анна" };
const args = ["Привет"];
console.log(Reflect.apply(fn, thisArg, args));
