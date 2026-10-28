const readline = require("node:readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question("Как вас зовут? ", answer => {
  console.log(`Привет, ${answer}!`);
  rl.close();
});
