const большое = 2n ** 63n;
const вЗнаковое = BigInt.asIntN(64, большое);

console.log(вЗнаковое);