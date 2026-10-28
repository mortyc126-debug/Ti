const source = new EventSource("/events");

source.addEventListener("update", event => {
  const data = JSON.parse(event.data);
  console.log(`Обновление: ${data.title}`);
});
