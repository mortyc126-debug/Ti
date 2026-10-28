async function task(item) {
  await new Promise(resolve => setTimeout(resolve, 30));
  console.log(`готово: ${item}`);
}

async function main() {
  for (const item of ["первый", "второй", "третий"]) {
    await task(item);
  }
  console.log("все задачи выполнены");
}

main();
