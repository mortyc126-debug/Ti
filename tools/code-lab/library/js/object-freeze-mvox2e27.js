const конфиг = Object.freeze({ лимит: 10, вложено: { флаг: true } });
console.log(Object.isFrozen(конфиг));
конфиг.вложено.флаг = false;
console.log(конфиг.вложено.флаг);
