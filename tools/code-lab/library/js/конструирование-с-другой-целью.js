class Основной {
  constructor(имя) { this.имя = имя; }
}
class Другой {}

const target = Основной;
const args = ["Анна"];
const newTarget = Другой;
const объект = Reflect.construct(target, args, newTarget);
console.log(объект instanceof Другой);
console.log(объект instanceof Основной);
console.log(объект.имя);
