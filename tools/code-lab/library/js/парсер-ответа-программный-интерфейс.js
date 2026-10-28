function разбор(ответ){
  const col = имя => ответ.columns.indexOf(имя); // имя колонки → её номер
  const iД = col("TRADEDATE");
  const iY = col("YIELDCLOSE");
  return ответ.data.map(строка => ({
    дата: строка[iД],
    доходность: строка[iY],
  }));
}