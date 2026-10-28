const умножить = (а, б) => а * б;
const удвоить = умножить.bind(null, 2);

console.log(удвоить(21));
