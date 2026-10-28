const объект = {};
Object.defineProperty(объект, "id", { value: 7 });

const { value: значение, writable: записываемое, enumerable: перечисляемое, configurable: настраиваемое } =
  Object.getOwnPropertyDescriptor(объект, "id");

console.log(значение, записываемое, перечисляемое, настраиваемое);
