const text = "скопированный текст";
navigator.clipboard.writeText(text)
  .then(() => console.log("текст в буфере обмена"))
  .catch(ошибка => console.log("не удалось скопировать:", ошибка.message));
