class МойМассив extends Array {
  static get [Symbol.species]() {
    return Array;
  }
}

const исходный = МойМассив.from([1, 2, 3]);
const удвоенный = исходный.map(число => число * 2);

console.log(исходный instanceof МойМассив);
console.log(удвоенный instanceof МойМассив);
