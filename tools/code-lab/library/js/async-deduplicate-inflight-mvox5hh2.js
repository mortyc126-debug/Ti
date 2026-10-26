const выполняются = new Map();
function одинЗапрос(ключ, загрузить) {
  if (выполняются.has(ключ)) return выполняются.get(ключ);
  const промис = Promise.resolve().then(загрузить).finally(() => выполняются.delete(ключ));
  выполняются.set(ключ, промис);
  return промис;
}
