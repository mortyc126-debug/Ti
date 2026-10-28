class Bond {}
const bond = new Bond();
console.log(bond instanceof Bond);
console.log(Object.getPrototypeOf(bond) === Bond.prototype);
