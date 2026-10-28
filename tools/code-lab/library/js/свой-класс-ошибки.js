class ОшибкаДанных extends Error {
  constructor(message, options) { super(message, options); this.name = "ОшибкаДанных"; }
}
try { throw new ОшибкаДанных("Неверный формат"); }
catch (ошибка) { console.log(ошибка.name); }
