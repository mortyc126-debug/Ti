function среднее(значения){
  const сумма = значения.reduce((a, b) => a + b, 0);
  return сумма / значения.length;
}

const результат = среднее([10, 20, 30]);
console.log(результат.toFixed(2)); // "20.00"