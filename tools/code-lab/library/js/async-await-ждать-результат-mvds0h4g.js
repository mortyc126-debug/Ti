const пауза = (мс) => new Promise((готово) => setTimeout(готово, мс));

async function main() {
  console.log("начали");
  await пауза(100);
  console.log("прошло 100 мс");
  return "готово";
}

main().then((результат) => console.log(результат));