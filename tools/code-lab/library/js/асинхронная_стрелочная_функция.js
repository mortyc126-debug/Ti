const загрузить = async номер => {
  await new Promise(пауза => setTimeout(пауза, 10));
  return { id: номер };
};

console.log(await загрузить(5));
