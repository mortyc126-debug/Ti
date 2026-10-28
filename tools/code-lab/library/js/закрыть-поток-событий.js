const source = new EventSource("/events");
let received = 0;

source.onmessage = event => {
  received += 1;
  console.log(`Сообщение ${received}: ${event.data}`);

  if (received === 5) {
    source.close();
    console.log("Поток закрыт");
  }
};
