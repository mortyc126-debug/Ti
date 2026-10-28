console.log(btoa("Hello"));

try {
  btoa("Привет");
} catch (ошибка) {
  console.log(ошибка.name);
}

const байты = new TextEncoder().encode("Привет");
console.log(btoa(String.fromCharCode(...байты)));
