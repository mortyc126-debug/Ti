const source = new EventSource("/events");

source.onerror = () => {
  if (source.readyState === EventSource.CLOSED) {
    console.log("Поток закрыт окончательно");
  } else {
    console.log("Связь потеряна, браузер переподключается");
  }
};
