function outer() {
  return inner();

  function inner() {
    return "inner вызвана до объявления";
  }
}

console.log(outer());

try {
  later();
} catch (error) {
  console.log(error.name);
}

const later = () => "поздно";
