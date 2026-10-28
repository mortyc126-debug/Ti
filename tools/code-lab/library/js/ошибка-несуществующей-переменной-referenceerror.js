const scope = { price: 100, quantity: 3 };

function readVariable(name) {
  if (!(name in scope)) {
    throw new ReferenceError(`${name} не определена`);
  }
  return scope[name];
}

console.log(readVariable("price"));

try {
  readVariable("discount");
} catch (error) {
  console.log(error.name, "-", error.message);
}
