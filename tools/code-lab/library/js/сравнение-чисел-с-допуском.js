let a = 0.1 + 0.2;
let b = 0.3;
console.log(a === b);
console.log(Math.abs(a - b) < Number.EPSILON);

a = 1000000.1 + 0.2;
b = 1000000.3;
console.log(Math.abs(a - b) < Number.EPSILON);
console.log(Math.abs(a - b) < Number.EPSILON * Math.max(Math.abs(a), Math.abs(b)) * 4);
