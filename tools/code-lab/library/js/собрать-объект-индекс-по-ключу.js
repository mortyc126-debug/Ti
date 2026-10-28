const записи = [{ id: "a", цена: 10 }, { id: "b", цена: 20 }];
const поId = записи.reduce((результат, запись) => {
  результат[запись.id] = запись;
  return результат;
}, Object.create(null));
console.log(поId.b.цена);
