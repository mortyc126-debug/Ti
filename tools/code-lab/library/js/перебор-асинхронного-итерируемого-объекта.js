async function* messages() {
  for (const text of ["привет", "как дела", "пока"]) {
    await new Promise(resolve => setTimeout(resolve, 30));
    yield text;
  }
}

async function main() {
  for await (const message of messages()) {
    console.log(message);
  }
}

main();
