function openResource(name) {
  console.log(`открыт: ${name}`);
  return {
    name,
    [Symbol.dispose]() {
      console.log(`закрыт: ${name}`);
    },
  };
}

function copyData() {
  using cleanup = new DisposableStack();
  const source = cleanup.use(openResource("источник"));
  const target = cleanup.use(openResource("приёмник"));

  console.log(`копирование ${source.name} → ${target.name}`);
}

copyData();
