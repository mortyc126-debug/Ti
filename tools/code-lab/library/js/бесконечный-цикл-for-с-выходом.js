let attempts = 0;

for (;;) {
  attempts += 1;
  console.log(`Попытка ${attempts}`);
  if (attempts * 7 % 5 === 1) break;
}

console.log(`Остановились после ${attempts} попыток`);
