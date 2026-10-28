function openConnection(name) {
  console.log(`открыто: ${name}`);
  return {
    name,
    [Symbol.dispose]() {
      console.log(`закрыто: ${name}`);
    },
  };
}

const stack = new DisposableStack();
const mainDb = stack.use(openConnection("основная база"));
const cacheDb = stack.use(openConnection("кэш"));

console.log(`работаем с ${mainDb.name} и ${cacheDb.name}`);
stack.dispose();
