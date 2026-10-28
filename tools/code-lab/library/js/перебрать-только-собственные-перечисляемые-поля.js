const объект = Object.create({ унаследовано: 1 });
объект.своё = 2;
for (const ключ in объект) {
  if (Object.hasOwn(объект, ключ)) console.log(ключ);
}
