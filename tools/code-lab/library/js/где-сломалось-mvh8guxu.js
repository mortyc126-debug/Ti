function inner() {
  console.trace('Мы здесь');
}

function outer() {
  inner();
}

outer();