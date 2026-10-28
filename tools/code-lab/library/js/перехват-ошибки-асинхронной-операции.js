async function operation() {
  throw new Error("Биржа недоступна");
}

async function main() {
  try {
    await operation();
    console.log("Операция выполнена");
  } catch (error) {
    console.log(`Ошибка: ${error.message}`);
  }
}

main();
