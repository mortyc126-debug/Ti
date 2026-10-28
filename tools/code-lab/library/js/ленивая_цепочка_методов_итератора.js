const результат = Iterator.from([1, 2, 3, 4, 5, 6])
  .map(число => число * 2)
  .filter(число => число % 3 === 0)
  .take(2)
  .toArray();

console.log(результат);
