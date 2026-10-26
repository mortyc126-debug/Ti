const объект = {};
Object.defineProperty(объект, "версия", { value: 1, enumerable: true, writable: false });
console.log(объект.версия);
console.log(Object.keys(объект));
