const поток = {
  [Symbol.asyncIterator]() {
    let номер = 0;
    return {
      async next() {
        номер += 1;
        return номер <= 3 ? { value: номер, done: false } : { value: undefined, done: true };
      },
    };
  },
};

for await (const элемент of поток) {
  console.log(элемент);
}
