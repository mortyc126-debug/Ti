function Точка(имя) {
  if (!new.target) {
    return new Точка(имя);
  }
  this.имя = имя;
}
console.log(Точка("без new").имя);
console.log(new Точка("с new").имя);

class Основа {
  constructor() { console.log(new.target.name); }
}
class Потомок extends Основа {}
new Потомок();
