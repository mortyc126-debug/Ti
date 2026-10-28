function acquireResource(name) {
  console.log(`замок взят: ${name}`);
  return {
    [Symbol.dispose]() {
      console.log(`замок отпущен: ${name}`);
    },
  };
}

{
  using lock = acquireResource("отчёт");
  console.log("работа внутри блока");
}

console.log("блок закончился");
