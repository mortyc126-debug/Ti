function assert(условие, сообщение = "Проверка не пройдена") {
  if (!условие) throw new Error(сообщение);
}
assert(2 + 2 === 4, "арифметика сломалась");
console.log("OK");
