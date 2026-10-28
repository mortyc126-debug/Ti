function acquire() {
  console.log("ресурс открыт");
  return {
    query: () => "данные",
    [Symbol.dispose]() {
      console.log("ресурс закрыт");
    },
  };
}

function readData() {
  using connection = acquire();
  return connection.query();
}

console.log(readData());
