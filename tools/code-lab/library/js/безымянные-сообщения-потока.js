const source = new EventSource("/events");

source.onmessage = event => {
  const data = JSON.parse(event.data);
  console.log(`Курс: ${data.rate}`);
};
