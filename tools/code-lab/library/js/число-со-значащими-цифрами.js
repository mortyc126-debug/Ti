const measurements = [3.14159265, 0.000123456, 123456];

for (const measurement of measurements) {
  console.log(`${measurement} → ${measurement.toPrecision(4)}`);
}
