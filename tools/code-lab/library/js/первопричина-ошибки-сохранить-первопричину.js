try {
  try { throw new Error("сбой сети"); }
  catch (исходная) { throw new Error("не удалось загрузить данные", { cause: исходная }); }
} catch (ошибка) { console.log(ошибка.cause.message); }
