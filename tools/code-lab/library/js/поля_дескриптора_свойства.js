const дескриптор = { value: 42, writable: false, enumerable: true, configurable: false };

const { value: значение, writable: записываемое, enumerable: перечисляемое, configurable: настраиваемое } = дескриптор;
console.log(значение, записываемое, перечисляемое, настраиваемое);
