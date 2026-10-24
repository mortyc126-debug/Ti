function разбор(csv){
  const строки = csv.trim().split("\n");
  const ключи = строки[0].split(",");       // заголовки
  return строки.slice(1).map(строка => {     // остальные строки
    const поля = строка.split(",");
    const объект = {};
    ключи.forEach((ключ, i) => объект[ключ] = поля[i]);
    return объект;
  });
}