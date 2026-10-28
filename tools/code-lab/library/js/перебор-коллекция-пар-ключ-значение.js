const числа = [1, 2, 3, 4];

const удвоенные = числа.map(x => x * 2);        // [2,4,6,8]
const чётные    = числа.filter(x => x % 2 === 0); // [2,4]
const сумма     = числа.reduce((acc, x) => acc + x, 0); // 10