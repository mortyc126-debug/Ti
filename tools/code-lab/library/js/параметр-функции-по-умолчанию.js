function greet(name = "гость") {
  return `Привет, ${name}!`;
}

console.log(greet());
console.log(greet(undefined));
console.log(greet("Мира"));
console.log(greet(null));
