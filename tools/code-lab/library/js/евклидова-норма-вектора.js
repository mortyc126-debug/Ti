const вектор = [3, 4];
const норма = Math.sqrt(вектор.reduce((сумма, значение) => сумма + значение ** 2, 0));
console.log(норма);
