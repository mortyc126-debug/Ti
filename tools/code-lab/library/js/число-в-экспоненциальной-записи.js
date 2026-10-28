const distances = [149600000, 0.000123, 42];

for (const distance of distances) {
  console.log(`${distance} → ${distance.toExponential(2)}`);
}
