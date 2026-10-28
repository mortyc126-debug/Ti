const исходный = {
  имя: "Мира",
  дата: new Date(0),
  карта: new Map([[1, 2]]),
  нет: undefined,
  список: [1, 2],
};

const копия = JSON.parse(JSON.stringify(исходный));
console.log(копия);
