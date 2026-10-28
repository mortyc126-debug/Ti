const settings = { theme: "dark" };

console.log(Reflect.preventExtensions(settings));
console.log(Reflect.set(settings, "fontSize", 14));
console.log(Reflect.isExtensible(settings));
settings.theme = "light";
console.log(settings);
