const request = {}; // вместо запроса indexedDB.open(имя, версия)
request.onblocked = () => {
  console.log("закройте другие вкладки с этим приложением");
};
request.onblocked?.();
